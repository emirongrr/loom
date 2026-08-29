import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianInvite, createGuardianSet, createRecoveryId, createRecoveryRequest } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { createGuardianRecoveryResponse, prepareGuardianRecoveryReview } from "../src/features/recovery/recoveryApproval.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const guardian = { kind: "erc1271", account: "0x2222222222222222222222222222222222222222", verifier: "0x3333333333333333333333333333333333333333", verifierCodeHash: `0x${"31".repeat(32)}`, salt: `0x${"32".repeat(32)}` } as const;
const set = createGuardianSet({ guardians: [guardian], threshold: 1 });
const capability = createGuardianInvite({ set, guardianLeaf: set.guardians[0]!.leaf, chainId: 11155111, account: ACCOUNT, accountAlias: "Protected account", issuerLabel: "Owner", guardianSetVersion: 1, configVersion: 4, capabilityId: `0x${"44".repeat(32)}`, expiresAt: 2_000_000_000 });
const validators = ["0x5555555555555555555555555555555555555555"] as const;
const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [validators]));
const identity = { account: ACCOUNT, oldValidatorsHash, newValidator: "0x6666666666666666666666666666666666666666", initDataHash: `0x${"67".repeat(32)}`, newGuardianRoot: `0x${"68".repeat(32)}`, newGuardianThreshold: 1, configVersion: 4, nonce: 0 } as const;
const request = createRecoveryRequest({ requestId: createRecoveryId(identity), chainId: 11155111, account: ACCOUNT, recoveryManager: "0x7777777777777777777777777777777777777777", guardianRoot: set.root, guardianThreshold: 1, configVersion: "4", nonce: "0", newValidator: identity.newValidator, initDataHash: identity.initDataHash, newGuardianRoot: identity.newGuardianRoot, newGuardianThreshold: 1, createdAt: 1_900_000_000, expiresAt: 1_900_086_400 });

test("guardian review binds the portable request to live account authority before signing", () => {
  const review = prepareGuardianRecoveryReview({ request, capability, live: { guardianRoot: set.root, guardianThreshold: 1, configVersion: 4n, validators } });
  const response = createGuardianRecoveryResponse({ review, signature: "0x1234", signedAt: 1_900_000_010 });
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.guardianLeaf, capability.guardian.leaf);
  assert.equal(response.recoveryDigest, review.digest);
});

test("guardian refuses a request bound to a stale validator set or configuration", () => {
  assert.throws(() => prepareGuardianRecoveryReview({ request, capability, live: { guardianRoot: set.root, guardianThreshold: 1, configVersion: 4n, validators: ["0x8888888888888888888888888888888888888888"] } }), /validator set/u);
  assert.throws(() => prepareGuardianRecoveryReview({ request, capability, live: { guardianRoot: set.root, guardianThreshold: 1, configVersion: 5n, validators } }), /configuration is stale/u);
});

// The invitation's expiry was the deadline for accepting the link. Refusing to
// sign after it passed cut a guardian off from an account they could still help
// with -- the chain verifies an approval against the guardian root and knows
// nothing about when the invitation was sent.
test("a guardian whose invitation lapsed can still sign for a matching root", () => {
  const lapsed = { ...capability, expiresAt: 1_800_000_000 };
  const review = prepareGuardianRecoveryReview({
    request, capability: lapsed,
    live: { guardianRoot: set.root, guardianThreshold: 1, configVersion: 4n, validators }
  });

  const response = createGuardianRecoveryResponse({ review, signature: "0x1234", signedAt: 1_900_000_010 });
  assert.equal(response.guardianLeaf, lapsed.guardian.leaf);
});

// The recovery's own window is a different thing and still binds: it is the
// window the account itself published.
test("the recovery request's own expiry still refuses a late signature", () => {
  const review = prepareGuardianRecoveryReview({
    request, capability,
    live: { guardianRoot: set.root, guardianThreshold: 1, configVersion: 4n, validators }
  });

  assert.throws(
    () => createGuardianRecoveryResponse({ review, signature: "0x1234", signedAt: request.expiresAt + 1 }),
    /recovery request expired/u
  );
});
