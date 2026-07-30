import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianSet, createRecoveryId, createRecoveryRequest, createRecoveryResponse, createGuardianProof } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { assertPendingRecoveryMatchesPrepared, assertPreparedRecoveryMatchesRequest, assertSuccessfulTransactionReceipt, restorePreparedRecovery, verifyRecoveryResponseForProposal } from "../src/features/recovery/recoveryProposal.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const VALIDATOR = "0x4444444444444444444444444444444444444444";
const OLD_VALIDATOR = "0x6666666666666666666666666666666666666666";
const CODE = "0x6001";
const INIT_DATA = "0x1234";
const INIT_DATA_HASH = keccak256(INIT_DATA);
const set = createGuardianSet({ guardians: [{ kind: "ecdsa", address: "0x5555555555555555555555555555555555555555", verifier: VERIFIER, verifierCodeHash: keccak256(CODE), salt: `0x${"31".repeat(32)}` }], threshold: 1 });
const freshSet = createGuardianSet({ guardians: [{ kind: "ecdsa", address: "0x5555555555555555555555555555555555555555", verifier: VERIFIER, verifierCodeHash: keccak256(CODE), salt: `0x${"32".repeat(32)}` }], threshold: 1 });
const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [[OLD_VALIDATOR]]));
const recoveryId = createRecoveryId({ account: ACCOUNT, oldValidatorsHash, newValidator: VALIDATOR, initDataHash: INIT_DATA_HASH, newGuardianRoot: freshSet.root, newGuardianThreshold: 1, configVersion: 1n, nonce: 0n });
const prepared = { account: ACCOUNT, newValidator: VALIDATOR, initDataHash: INIT_DATA_HASH, newGuardianSet: freshSet, configVersion: 1n, nonce: 0n, recoveryId, digest: `0x${"61".repeat(32)}` } as never;
const request = createRecoveryRequest({ requestId: recoveryId, chainId: 11155111, account: ACCOUNT, recoveryManager: MANAGER, guardianRoot: set.root, guardianThreshold: 1, configVersion: "1", nonce: "0", newValidator: VALIDATOR, initDataHash: INIT_DATA_HASH, newGuardianRoot: freshSet.root, newGuardianThreshold: 1, createdAt: 1_900_000_000, expiresAt: 1_900_086_400 });
const member = set.guardians[0]!;
const response = createRecoveryResponse({ requestId: request.requestId, chainId: request.chainId, account: request.account, recoveryDigest: `0x${"61".repeat(32)}`, guardianLeaf: member.leaf, verifier: member.verifier, keyCommitment: member.keyCommitment, salt: member.salt, proof: createGuardianProof(set, member.leaf), signature: "0x1234", signedAt: 1_900_000_010, expiresAt: request.expiresAt });

test("proposal response validation binds request, live verifier, proof, digest, and signature", async () => {
  const approval = await verifyRecoveryResponseForProposal({ response, request, prepared, readCode: async () => CODE, verifySignature: async () => true });
  assert.equal(approval.leaf, member.leaf);
  await assert.rejects(verifyRecoveryResponseForProposal({ response: { ...response, recoveryDigest: `0x${"ff".repeat(32)}` }, request, prepared, readCode: async () => CODE, verifySignature: async () => true }), /different recovery digest/u);
  await assert.rejects(verifyRecoveryResponseForProposal({ response, request, prepared, readCode: async () => "0x6002", verifySignature: async () => true }), /leaf/u);
  await assert.rejects(verifyRecoveryResponseForProposal({ response, request, prepared, readCode: async () => CODE, verifySignature: async () => false }), /signature/u);
});

test("stale prepared recovery cannot be proposed from a reviewed request", () => {
  assert.throws(() => assertPreparedRecoveryMatchesRequest({ ...prepared, nonce: 1n } as never, request), /no longer matches/u);
});

test("pending recovery execution is reconstructed only from request-bound encrypted material", () => {
  const restored = restorePreparedRecovery({ request, initData: INIT_DATA, oldValidators: [OLD_VALIDATOR], newGuardianSet: freshSet });
  assert.equal(restored.recoveryId, request.requestId);
  assert.match(restored.digest, /^0x[0-9a-f]{64}$/u);
  assert.throws(() => restorePreparedRecovery({ request, initData: INIT_DATA, oldValidators: [], newGuardianSet: freshSet }), /previous validator set/u);
  assert.throws(() => restorePreparedRecovery({ request, initData: "0xabcd", oldValidators: [OLD_VALIDATOR], newGuardianSet: freshSet }), /initialization data/u);
  assert.throws(() => restorePreparedRecovery({ request: { ...request, requestId: `0x${"ff".repeat(32)}` }, initData: INIT_DATA, oldValidators: [OLD_VALIDATOR], newGuardianSet: freshSet }), /no longer matches/u);
});

test("pending chain state must match every reviewed recovery identity field", () => {
  const fullPrepared = restorePreparedRecovery({ request, initData: INIT_DATA, oldValidators: [OLD_VALIDATOR], newGuardianSet: freshSet });
  const pending = {
    pending: true,
    oldValidatorsHash: fullPrepared.oldValidatorsHash,
    newValidator: fullPrepared.newValidator,
    initDataHash: fullPrepared.initDataHash,
    newGuardianRoot: fullPrepared.newGuardianSet.root,
    newGuardianThreshold: fullPrepared.newGuardianSet.threshold,
    configVersion: fullPrepared.configVersion,
    nonce: fullPrepared.nonce
  };
  assert.doesNotThrow(() => assertPendingRecoveryMatchesPrepared(pending, fullPrepared));
  assert.throws(() => assertPendingRecoveryMatchesPrepared({ ...pending, nonce: 1n }, fullPrepared), /does not match this reviewed request/iu);
  assert.throws(() => assertPendingRecoveryMatchesPrepared({ ...pending, newValidator: ACCOUNT }, fullPrepared), /does not match this reviewed request/iu);
});

test("reverted transaction receipts never advance recovery", () => {
  assert.doesNotThrow(() => assertSuccessfulTransactionReceipt({ status: "success" }));
  assert.throws(() => assertSuccessfulTransactionReceipt({ status: "reverted" }), /reverted on chain/iu);
});
