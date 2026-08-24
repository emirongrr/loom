import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters } from "viem";

import { createGuardianInvite, createGuardianSet } from "@loom/sdk/recovery";
import {
  guardianCapabilityMatchesAccount,
  signFreezeDigestWithPasskey
} from "../src/features/guardians/freezeSigning.ts";
import {
  assertGuardianCapabilityMatchesAccount,
  guardianVaultRecordsForAccount,
  reviewableGuardianCapabilitiesForAccount
} from "../src/storage/guardianVaultScope.ts";
import type { AccountHandle } from "../src/types.ts";

const ACCOUNT = "0x73E1Fc60aB8b5F31a36a640d1f8035E99cE8192C";
const OWNER = "0xe5CDbB47df6AD1319a5BC124D9233e05c89C9eD1";
const VALIDATOR = "0x1111111111111111111111111111111111111111";
const VERIFIER = "0x2222222222222222222222222222222222222222";
const CODE_HASH = `0x${"ab".repeat(32)}` as const;
const DIGEST = `0x${"cd".repeat(32)}` as const;

function account(address = ACCOUNT): AccountHandle {
  return {
    version: 1,
    kind: "recovered",
    id: `11155111:${address.toLowerCase()}`,
    label: "Guardian wallet",
    account: address as `0x${string}`,
    chainId: 11_155_111,
    credentialId: `0x${"01".repeat(32)}`,
    publicKey: { x: `0x${"02".repeat(32)}`, y: `0x${"03".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5174",
    validator: VALIDATOR
  };
}

function invite(guardianAddress = ACCOUNT, capabilityByte = "05") {
  const set = createGuardianSet({
    guardians: [{
      kind: "erc1271",
      account: guardianAddress as `0x${string}`,
      verifier: VERIFIER,
      verifierCodeHash: CODE_HASH,
      salt: `0x${"04".repeat(32)}`
    }],
    threshold: 1
  });
  return createGuardianInvite({
    set,
    guardianLeaf: set.guardians[0]!.leaf,
    chainId: 11_155_111,
    account: OWNER,
    accountAlias: "Protected account",
    issuerLabel: "Account owner",
    guardianSetVersion: 1,
    configVersion: 1n,
    capabilityId: `0x${capabilityByte.repeat(32)}` as `0x${string}`,
    expiresAt: 2_000_000_000
  });
}

function p256Invite() {
  const guardian = account();
  const set = createGuardianSet({
    guardians: [{
      kind: "p256",
      publicKey: guardian.publicKey,
      verifier: VERIFIER,
      verifierCodeHash: CODE_HASH,
      salt: `0x${"08".repeat(32)}`
    }],
    threshold: 1
  });
  return createGuardianInvite({
    set, guardianLeaf: set.guardians[0]!.leaf, chainId: guardian.chainId,
    account: OWNER, accountAlias: "Protected account", issuerLabel: "Account owner",
    guardianSetVersion: 1, configVersion: 1n, capabilityId: `0x${"09".repeat(32)}`,
    expiresAt: 2_000_000_000
  });
}

test("a Loom guardian signs directly for the P-256 guardian verifier", async () => {
  const capability = p256Invite();
  const guardian = account();
  const signature = await signFreezeDigestWithPasskey({
    capability, account: guardian, digest: DIGEST,
    signChallenge: async () => ({
      authenticatorData: `0x${"06".repeat(37)}`,
      clientDataJSON: "0x7b7d",
      signature: `0x${"11".repeat(32)}${"22".repeat(32)}`
    })
  });
  const [key, webAuthn] = decodeAbiParameters(
    [{ type: "tuple", components: [{ name: "x", type: "bytes32" }, { name: "y", type: "bytes32" }, { name: "rpIdHash", type: "bytes32" }, { name: "originHash", type: "bytes32" }] },
      { type: "tuple", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "bytes" }, { name: "origin", type: "bytes" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }],
    signature
  );
  assert.equal(key.x, guardian.publicKey.x);
  assert.equal(key.y, guardian.publicKey.y);
  assert.equal(webAuthn.authenticatorData, `0x${"06".repeat(37)}`);
  assert.equal(guardianCapabilityMatchesAccount(capability, guardian), true);
});

test("a legacy ERC-1271 Loom guardian fails before prompting for a passkey", async () => {
  const capability = invite();
  const guardian = account();
  let prompted = false;
  await assert.rejects(signFreezeDigestWithPasskey({
    capability,
    account: guardian,
    digest: DIGEST,
    signChallenge: async () => {
      prompted = true;
      throw new Error("must not prompt");
    }
  }), /uses the Loom account address/u);
  assert.equal(prompted, false);
  assert.equal(guardianCapabilityMatchesAccount(capability, guardian), true);
});

test("a different local account or an ECDSA capability cannot use the passkey shortcut", async () => {
  const capability = invite();
  assert.equal(guardianCapabilityMatchesAccount(capability, account(OWNER)), false);
  await assert.rejects(() => signFreezeDigestWithPasskey({
    capability,
    account: account(OWNER),
    digest: DIGEST,
    signChallenge: async () => { throw new Error("must not prompt"); }
  }), /does not match this guardian capability/);
});

test("accepted capabilities are visible only in the matching local guardian wallet", () => {
  const capability = invite();
  const matchingRecord = { capability, acceptedAt: 1_900_000_000_000, status: "unverified" as const };
  const otherCapability = invite(OWNER, "07");
  const otherRecord = { capability: otherCapability, acceptedAt: 1_900_000_000_001, status: "unverified" as const };
  const records = [matchingRecord, otherRecord];

  assert.deepEqual(guardianVaultRecordsForAccount(records, account()), [matchingRecord]);
  assert.deepEqual(guardianVaultRecordsForAccount(records, account(OWNER)), [otherRecord]);
  assert.throws(
    () => assertGuardianCapabilityMatchesAccount(capability, account(OWNER)),
    /issued to a different wallet/u
  );
});

test("recovery review is available only to the open wallet's live accepted capabilities", () => {
  const matchingRecord = { capability: invite(), acceptedAt: 1_900_000_000_000, status: "unverified" as const };
  const staleRecord = { ...matchingRecord, status: "stale" as const };

  assert.deepEqual(reviewableGuardianCapabilitiesForAccount([matchingRecord], account(), 1_900_000_000), [matchingRecord]);
  assert.deepEqual(reviewableGuardianCapabilitiesForAccount([matchingRecord], account(OWNER), 1_900_000_000), []);
  assert.deepEqual(reviewableGuardianCapabilitiesForAccount([staleRecord], account(), 1_900_000_000), []);
  assert.deepEqual(reviewableGuardianCapabilitiesForAccount([matchingRecord], account(), 2_000_000_000), []);
});
