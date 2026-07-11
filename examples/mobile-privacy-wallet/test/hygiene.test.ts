import assert from "node:assert/strict";
import test from "node:test";

import { createClipboardHygiene, type ClipboardBackend, type ScheduleFn } from "../src/platform/clipboardHygiene";
import { MobileWalletConfigurationError } from "../src/platform/errors";
import {
  createSecureLocalStore,
  SECURE_STORE_ALLOWED_KEYS,
  type SecureStoreBackend,
  type SecureStoreKey
} from "../src/platform/secureStore";

function memoryBackend() {
  const values = new Map<string, string>();
  const backend: SecureStoreBackend = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async deleteItem(key) {
      values.delete(key);
    }
  };
  return { backend, values };
}

void test("secure store only accepts allowlisted keys", async () => {
  const { backend, values } = memoryBackend();
  const store = createSecureLocalStore({ backend });

  await store.set("loom.credentialIdHash", "0x" + "ab".repeat(32));
  assert.equal(values.get("loom.credentialIdHash"), "0x" + "ab".repeat(32));
  assert.equal(await store.get("loom.credentialIdHash"), "0x" + "ab".repeat(32));

  for (const forbidden of [
    "loom.credentialId",
    "loom.attestationObject",
    "loom.viewingKey",
    "loom.accountGraph",
    "loom.privateKey",
    "arbitrary.key"
  ]) {
    await assert.rejects(
      store.set(forbidden as SecureStoreKey, "value"),
      MobileWalletConfigurationError,
      `expected ${forbidden} to be rejected`
    );
    assert.equal(values.has(forbidden), false, `${forbidden} must not reach the backend`);
  }
});

void test("secure store rejects empty and oversized values", async () => {
  const { backend } = memoryBackend();
  const store = createSecureLocalStore({ backend });

  await assert.rejects(store.set("loom.credentialIdHash", ""), MobileWalletConfigurationError);
  await assert.rejects(
    store.set("loom.guardianBackup.encrypted", "x".repeat(16 * 1024 + 1)),
    MobileWalletConfigurationError
  );
});

void test("secure store allowlist itself never names forbidden material", () => {
  for (const key of SECURE_STORE_ALLOWED_KEYS) {
    assert.doesNotMatch(key, /credentialId(?!Hash)|attestation|viewingKey|accountGraph|privateKey|mnemonic|seed/i);
  }
});

function manualScheduler() {
  const pending: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule: ScheduleFn = (callback, delayMs) => {
    const entry = { callback, delayMs, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const fire = async () => {
    for (const entry of pending.splice(0)) {
      if (!entry.cancelled) {
        entry.callback();
      }
    }
    // Let the clear-if-unchanged promise chain settle.
    await new Promise(resolve => setImmediate(resolve));
  };
  return { schedule, fire, pending };
}

function fakeClipboard(): ClipboardBackend & { value: string } {
  return {
    value: "",
    async getString() {
      return this.value;
    },
    async setString(next: string) {
      this.value = next;
    }
  };
}

void test("clipboard hygiene clears a copied value after the TTL", async () => {
  const clipboard = fakeClipboard();
  const { schedule, fire } = manualScheduler();
  const hygiene = createClipboardHygiene({ clipboard, ttlMs: 1_000, schedule });

  const receipt = await hygiene.copySensitive("0xdeadbeef");
  assert.equal(receipt.clearsInMs, 1_000);
  assert.equal(clipboard.value, "0xdeadbeef");

  await fire();
  assert.equal(clipboard.value, "", "clipboard must be cleared after the TTL");
});

void test("clipboard hygiene never clobbers a value the user copied afterwards", async () => {
  const clipboard = fakeClipboard();
  const { schedule, fire } = manualScheduler();
  const hygiene = createClipboardHygiene({ clipboard, ttlMs: 1_000, schedule });

  await hygiene.copySensitive("0xdeadbeef");
  clipboard.value = "something the user copied";

  await fire();
  assert.equal(clipboard.value, "something the user copied");
});

void test("clipboard hygiene rejects empty values and invalid TTLs", async () => {
  const clipboard = fakeClipboard();
  assert.throws(
    () => createClipboardHygiene({ clipboard, ttlMs: 0 }),
    MobileWalletConfigurationError
  );
  const hygiene = createClipboardHygiene({ clipboard, ttlMs: 1_000, schedule: manualScheduler().schedule });
  await assert.rejects(hygiene.copySensitive(""), MobileWalletConfigurationError);
});

void test("a re-copy cancels the previous pending clear", async () => {
  const clipboard = fakeClipboard();
  const { schedule, fire, pending } = manualScheduler();
  const hygiene = createClipboardHygiene({ clipboard, ttlMs: 1_000, schedule });

  await hygiene.copySensitive("first");
  await hygiene.copySensitive("second");
  assert.equal(pending.filter(entry => !entry.cancelled).length, 1);

  await fire();
  assert.equal(clipboard.value, "", "second value is cleared by its own timer");
});

void test("challenge generation rejects wrong lengths and all-zero entropy", async () => {
  const { challengeFromBytes, createChallengeSource, CHALLENGE_BYTE_LENGTH } = await import(
    "../src/platform/challenge"
  );

  assert.equal(CHALLENGE_BYTE_LENGTH, 32);
  assert.throws(() => challengeFromBytes(new Uint8Array(16)), MobileWalletConfigurationError);
  assert.throws(() => challengeFromBytes(new Uint8Array(32)), MobileWalletConfigurationError);

  const bytes = new Uint8Array(32);
  bytes[0] = 0xab;
  bytes[31] = 0x01;
  assert.equal(challengeFromBytes(bytes), "0xab" + "00".repeat(30) + "01");

  const source = createChallengeSource(async count => {
    const random = new Uint8Array(count);
    random.fill(0x7f);
    return random;
  });
  assert.equal(await source.freshChallenge(), "0x" + "7f".repeat(32));

  const zeroSource = createChallengeSource(async count => new Uint8Array(count));
  await assert.rejects(zeroSource.freshChallenge(), MobileWalletConfigurationError);
});

void test("endpoint overrides validate URLs and never weaken environment values", async () => {
  const { applyEndpointOverrides, assertEndpointUrl, loadEndpointOverrides, saveEndpointOverride } =
    await import("../src/config/runtimeOverrides");
  const { createSecureLocalStore } = await import("../src/platform/secureStore");
  const { backend, values } = memoryBackend();
  const store = createSecureLocalStore({ backend });

  assert.throws(() => assertEndpointUrl("not a url", "Bundler URL"), MobileWalletConfigurationError);
  assert.throws(() => assertEndpointUrl("http://insecure.example", "Bundler URL"), MobileWalletConfigurationError);
  assert.equal(assertEndpointUrl(" https://bundler.example ", "Bundler URL"), "https://bundler.example");
  assert.equal(assertEndpointUrl("http://localhost:4337", "Bundler URL"), "http://localhost:4337");

  await saveEndpointOverride(store, "bundler", "https://bundler.example");
  assert.equal(values.get("loom.endpoints.bundler"), "https://bundler.example");

  const overrides = await loadEndpointOverrides(store);
  assert.equal(overrides.bundlerUrl, "https://bundler.example");
  assert.equal(overrides.rpcUrl, undefined);

  const config = {
    network: { chainId: 1, l1ChainId: 1, rpcUrl: "https://env-rpc.example", bundlerUrl: undefined }
  } as unknown as import("../src/types/wallet").MobileWalletConfiguration;
  const merged = applyEndpointOverrides(config, overrides);
  assert.equal(merged.network.bundlerUrl, "https://bundler.example");
  assert.equal(merged.network.rpcUrl, "https://env-rpc.example", "an absent override must fall back to the environment");

  await saveEndpointOverride(store, "bundler", "   ");
  assert.equal(values.has("loom.endpoints.bundler"), false, "clearing removes the override entirely");
});

void test("bundler profiles can be added, switched, and removed, and activating writes the single active override", async () => {
  const { activateBundlerProfile, addBundlerProfile, loadBundlerProfiles, loadEndpointOverrides, removeBundlerProfile } =
    await import("../src/config/runtimeOverrides");
  const { createSecureLocalStore } = await import("../src/platform/secureStore");
  const { MobileWalletConfigurationError } = await import("../src/platform/errors");
  const { backend } = memoryBackend();
  const store = createSecureLocalStore({ backend });

  await assert.rejects(addBundlerProfile(store, "  ", "https://bundler-a.example"), MobileWalletConfigurationError);
  await assert.rejects(addBundlerProfile(store, "Primary", "not a url"), MobileWalletConfigurationError);

  const afterFirst = await addBundlerProfile(store, "Primary", "https://bundler-a.example");
  assert.equal(afterFirst.length, 1);
  const primary = afterFirst[0];
  assert.ok(primary);
  assert.equal(primary.label, "Primary");
  assert.equal(primary.url, "https://bundler-a.example");

  await assert.rejects(
    addBundlerProfile(store, "Primary", "https://bundler-b.example"),
    MobileWalletConfigurationError,
    "duplicate labels must be rejected"
  );

  const afterSecond = await addBundlerProfile(store, "Backup", "https://bundler-b.example");
  assert.equal(afterSecond.length, 2);
  const backup = afterSecond[1];
  assert.ok(backup);

  await assert.rejects(activateBundlerProfile(store, "does-not-exist"), MobileWalletConfigurationError);

  const activated = await activateBundlerProfile(store, backup.id);
  assert.equal(activated.label, "Backup");
  const overridesAfterActivate = await loadEndpointOverrides(store);
  assert.equal(
    overridesAfterActivate.bundlerUrl,
    "https://bundler-b.example",
    "activating a profile must write its URL as the single active bundler override"
  );

  const afterRemove = await removeBundlerProfile(store, primary.id);
  assert.equal(afterRemove.length, 1);
  const remaining = afterRemove[0];
  assert.ok(remaining);
  assert.equal(remaining.label, "Backup");

  const afterRemoveLast = await removeBundlerProfile(store, backup.id);
  assert.deepEqual(afterRemoveLast, []);
  assert.deepEqual(await loadBundlerProfiles(store), []);
});
