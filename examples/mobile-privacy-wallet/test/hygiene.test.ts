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
