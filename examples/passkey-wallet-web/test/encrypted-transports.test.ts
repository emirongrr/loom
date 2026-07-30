import assert from "node:assert/strict";
import test from "node:test";

import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { createGuardianInvite, createGuardianSet, validateGuardianInvite } from "@loom/sdk/recovery";
import { assertGuardianVaultAdmission, decodeGuardianVaultEntries } from "../src/storage/guardianVault.ts";
import { createEncryptedLinkTransport, receiveGuardianInvite } from "../src/transports/invitations.ts";

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
  const otherGuardianSet = createGuardianSet({
    guardians: [{
      kind: "ecdsa",
      address: "0x7777777777777777777777777777777777777777",
      verifier: "0x3333333333333333333333333333333333333333",
      verifierCodeHash: `0x${"a1".repeat(32)}`,
      salt: `0x${"b2".repeat(32)}`
    }],
    threshold: 1
  });
  const otherGuardian = createGuardianInvite({
    set: otherGuardianSet,
    guardianLeaf: otherGuardianSet.guardians[0].leaf,
    chainId: healthy.chainId,
    account: healthy.account,
    accountAlias: "Savings",
    issuerLabel: "Alice",
    guardianSetVersion: 7,
    configVersion: 9n,
    capabilityId: `0x${"cc".repeat(32)}`,
    expiresAt: now + 60
  });

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
  const otherGuardianEnvelope = await encrypt({ capability: otherGuardian, acceptedAt: 1_900_000_000_001, status: "active" });
  const corruptEnvelope = {
    ...healthyEnvelope,
    ciphertext: `${healthyEnvelope.ciphertext[0] === "A" ? "B" : "A"}${healthyEnvelope.ciphertext.slice(1)}`
  };
  const malformedEnvelope = await encrypt({ capability: {}, acceptedAt: 1_900_000_000_000, status: "active" });

  const snapshot = await decodeGuardianVaultEntries([
    { key: expired.capabilityId, envelope: expiredEnvelope },
    { key: "corrupt-record", envelope: corruptEnvelope },
    { key: "malformed-record", envelope: malformedEnvelope },
    { key: healthy.capabilityId, envelope: healthyEnvelope },
    { key: otherGuardian.capabilityId, envelope: otherGuardianEnvelope }
  ], key, now);

  assert.deepEqual(snapshot.records.map(record => [record.capability.capabilityId, record.status]), [
    [healthy.capabilityId, "active"],
    [otherGuardian.capabilityId, "active"]
  ], "an expired duplicate cannot hide the healthy record and a different guardian remains independent");
  assert.deepEqual(snapshot.issues.map(issue => [issue.key, issue.reason]), [
    ["corrupt-record", "corrupt"],
    ["malformed-record", "corrupt"]
  ]);

  const healthyRecord = { capability: healthy, acceptedAt: 1_900_000_000_000, status: "active" as const };
  assert.throws(
    () => assertGuardianVaultAdmission([healthyRecord], { ...healthyRecord, acceptedAt: healthyRecord.acceptedAt + 1 }, now),
    /already accepted/u
  );
  assert.doesNotThrow(() => assertGuardianVaultAdmission([
    { capability: expired, acceptedAt: healthyRecord.acceptedAt - 1, status: "stale" }
  ], healthyRecord, now), "an expired capability may be refreshed without creating a second visible account");
  assert.doesNotThrow(
    () => assertGuardianVaultAdmission([healthyRecord], { capability: otherGuardian, acceptedAt: healthyRecord.acceptedAt + 1, status: "active" }, now),
    "another guardian wallet may independently protect the same account"
  );
});
