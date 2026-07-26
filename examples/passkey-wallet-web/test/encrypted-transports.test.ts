import assert from "node:assert/strict";
import test from "node:test";

import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { createGuardianInvite, createGuardianSet, validateGuardianInvite } from "@loom/sdk/recovery";
import { decodeGuardianVaultEntries } from "../src/storage/guardianVault.ts";
import { createEncryptedLinkTransport, createFileInvitationTransport, createMemoryInvitationTransport, receiveGuardianInvite } from "../src/transports/invitations.ts";
import { createEncryptedRecoveryRoom, createMemoryMailbox } from "../src/transports/recoveryRoom.ts";
import { createRpcSimulationAdapter } from "../src/transports/simulation.ts";

test("encrypted invitation links keep capability material in the fragment", async () => {
  const transport = createEncryptedLinkTransport<{ secret: string }>({ origin: "https://wallet.example" });
  const delivered = await transport.deliver({ secret: "guardian-only" });
  const url = new URL(delivered.value);
  assert.equal(url.search, "");
  assert.ok(url.hash.startsWith("#cap="));
  assert.equal(delivered.value.includes("guardian-only"), false);
  assert.deepEqual(await transport.receive(delivered.value), { secret: "guardian-only" });
  await assert.rejects(transport.receive(delivered.value.replace("wallet.example", "attacker.example")), /origin/u);
});

test("file transport bounds input and memory transport is one-time", async () => {
  const files = createFileInvitationTransport<{ id: number }>();
  const file = await files.deliver({ id: 7 });
  assert.deepEqual(await files.receive(file.value), { id: 7 });
  await assert.rejects(files.receive("x".repeat(32_769)), /exceeds/u);

  const memory = createMemoryInvitationTransport<{ id: number }>();
  const message = await memory.deliver({ id: 9 });
  assert.deepEqual(await memory.receive(message.value), { id: 9 });
  await assert.rejects(memory.receive(message.value), /not found/u);
});

test("decrypted invitation links are validated before acceptance", async () => {
  const transport = createEncryptedLinkTransport<GuardianInviteV1>({ origin: "https://wallet.example" });
  const delivered = await transport.deliver({ version: 1 } as GuardianInviteV1);
  await assert.rejects(receiveGuardianInvite(delivered.value, transport), /critical field|unknown critical fields/u);
});

test("guardian vault isolates corrupt records and retains expired records as stale", async () => {
  const set = createGuardianSet({
    guardians: [{
      kind: "ecdsa",
      address: "0x6666666666666666666666666666666666666666",
      verifier: "0x3333333333333333333333333333333333333333",
      verifierCodeHash: `0x${"a1".repeat(32)}`,
      salt: `0x${"b1".repeat(32)}`
    }],
    threshold: 1
  });
  const now = 2_000_000_000;
  const createInvite = (capabilityByte: string, expiresAt: number) => createGuardianInvite({
    set,
    guardianLeaf: set.guardians[0].leaf,
    chainId: 11155111,
    account: "0x1111111111111111111111111111111111111111",
    accountAlias: "Savings",
    issuerLabel: "Alice",
    guardianSetVersion: 7,
    configVersion: 9n,
    capabilityId: `0x${capabilityByte.repeat(32)}` as `0x${string}`,
    expiresAt
  });
  const expired = createInvite("ca", now - 1);
  const healthy = createInvite("cb", now + 60);

  assert.throws(() => validateGuardianInvite(expired, { now }), /expired/u, "new acceptance remains fail-closed");

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const encrypt = async (value: unknown) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value))
    ));
    const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    return { version: 1 as const, iv: encode(iv), ciphertext: encode(ciphertext) };
  };
  const expiredEnvelope = await encrypt({ capability: expired, acceptedAt: 1_900_000_000_000, status: "active" });
  const healthyEnvelope = await encrypt({ capability: healthy, acceptedAt: 1_900_000_000_000, status: "active" });
  const corruptEnvelope = {
    ...healthyEnvelope,
    ciphertext: `${healthyEnvelope.ciphertext[0] === "A" ? "B" : "A"}${healthyEnvelope.ciphertext.slice(1)}`
  };
  const malformedEnvelope = await encrypt({ capability: {}, acceptedAt: 1_900_000_000_000, status: "active" });

  const snapshot = await decodeGuardianVaultEntries([
    { key: expired.capabilityId, envelope: expiredEnvelope },
    { key: "corrupt-record", envelope: corruptEnvelope },
    { key: "malformed-record", envelope: malformedEnvelope },
    { key: healthy.capabilityId, envelope: healthyEnvelope }
  ], key, now);

  assert.deepEqual(snapshot.records.map(record => [record.capability.capabilityId, record.status]), [
    [expired.capabilityId, "stale"],
    [healthy.capabilityId, "active"]
  ]);
  assert.deepEqual(snapshot.issues.map(issue => [issue.key, issue.reason]), [
    ["corrupt-record", "corrupt"],
    ["malformed-record", "corrupt"]
  ]);
});

test("RPC simulation sends one encoded account operation instead of independent calls", async () => {
  const requests: unknown[][] = [];
  const encoded = "0xdeadbeef" as const;
  const adapter = createRpcSimulationAdapter({
    async request(_method, params) { requests.push([...params]); return "0x"; },
    executionCaller: "0x4444444444444444444444444444444444444444",
    blockTag: "0x123",
    encodeAccountCall({ calls }) { assert.equal(calls.length, 2); return encoded; }
  });
  const account = "0x1111111111111111111111111111111111111111" as const;
  const result = await adapter.simulate({ account, calls: [
    { target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0x" },
    { target: "0x3333333333333333333333333333333333333333", value: 1n, data: "0x12" }
  ] });
  assert.equal(result.status, "verified");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], [{ from: "0x4444444444444444444444444444444444444444", to: account, data: encoded }, "0x123"]);
});

test("recovery room stores only ciphertext and consumes messages once", async () => {
  const stored: Uint8Array[] = [];
  const backing = createMemoryMailbox();
  const room = createEncryptedRecoveryRoom<{ approval: string }>({
    async put(id, ciphertext, expiresAt) {
      stored.push(ciphertext.slice());
      await backing.put(id, ciphertext, expiresAt);
    },
    take: backing.take
  });
  const published = await room.publish({ approval: "signed-root" }, Math.floor(Date.now() / 1000) + 60);
  assert.equal(new TextDecoder().decode(stored[0]).includes("signed-root"), false);
  assert.deepEqual(await room.collect(published.roomId, published.key), { approval: "signed-root" });
  assert.equal(await room.collect(published.roomId, published.key), null);
});
