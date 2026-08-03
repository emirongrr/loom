import type { Address, Hex } from "@loom/core";
import {
  createRecoveryId, createRecoveryProposalDigest, createRecoveryResponse, verifyGuardianProof,
  type GuardianInviteV1, type RecoveryRequestV1, type RecoveryResponseV1
} from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

export interface GuardianRecoveryReview {
  readonly request: RecoveryRequestV1;
  readonly capability: GuardianInviteV1;
  readonly digest: Hex;
  readonly oldValidatorsHash: Hex;
}

export function prepareGuardianRecoveryReview(input: {
  readonly request: RecoveryRequestV1;
  readonly capability: GuardianInviteV1;
  readonly live: { readonly guardianRoot: Hex; readonly guardianThreshold: number; readonly configVersion: bigint; readonly validators: readonly Address[] };
}): GuardianRecoveryReview {
  const { request, capability, live } = input;
  if (request.chainId !== capability.chainId || request.account.toLowerCase() !== capability.account.toLowerCase()) throw new Error("This recovery request belongs to another protected account.");
  if (request.guardianRoot !== capability.guardianRoot || request.guardianRoot !== live.guardianRoot) throw new Error("The recovery request does not use the active guardian root.");
  if (request.guardianThreshold !== capability.threshold || request.guardianThreshold !== live.guardianThreshold) throw new Error("The recovery request guardian threshold is stale.");
  if (request.configVersion !== capability.configVersion || request.configVersion !== live.configVersion.toString()) throw new Error("The recovery request configuration is stale.");
  if (request.newGuardianRoot === live.guardianRoot) throw new Error("Recovery must rotate the guardian root.");
  if (!verifyGuardianProof({ root: live.guardianRoot, leaf: capability.guardian.leaf, proof: capability.proof })) throw new Error("Your guardian capability no longer belongs to the active root.");
  const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [live.validators]));
  const identity = {
    account: request.account, oldValidatorsHash, newValidator: request.newValidator, initDataHash: request.initDataHash,
    newGuardianRoot: request.newGuardianRoot, newGuardianThreshold: request.newGuardianThreshold,
    configVersion: BigInt(request.configVersion), nonce: BigInt(request.nonce)
  };
  if (createRecoveryId(identity) !== request.requestId) throw new Error("The recovery request does not match the live validator set.");
  return Object.freeze({
    request, capability, oldValidatorsHash,
    digest: createRecoveryProposalDigest({ ...identity, chainId: request.chainId, recoveryManager: request.recoveryManager })
  });
}

export function createGuardianRecoveryResponse(input: {
  readonly review: GuardianRecoveryReview;
  readonly signature: Hex;
  readonly signedAt: number;
}): RecoveryResponseV1 {
  const { request, capability, digest } = input.review;
  if (input.signedAt >= request.expiresAt || input.signedAt >= capability.expiresAt) throw new Error("The recovery request or guardian capability expired before signing.");
  return createRecoveryResponse({
    requestId: request.requestId,
    chainId: request.chainId,
    account: request.account,
    recoveryDigest: digest,
    guardianLeaf: capability.guardian.leaf,
    verifier: capability.guardian.verifier,
    keyCommitment: capability.guardian.keyCommitment,
    salt: capability.guardian.salt,
    proof: capability.proof,
    signature: input.signature,
    signedAt: input.signedAt,
    expiresAt: Math.min(request.expiresAt, capability.expiresAt)
  });
}
