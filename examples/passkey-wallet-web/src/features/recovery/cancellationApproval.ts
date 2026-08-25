import type { Address, Hex } from "@loom/core";
import {
  createCancelResponse, createRecoveryCancellationDigest, createRecoveryId, verifyGuardianProof,
  type CancelRequestV1, type CancelResponseV1, type GuardianInviteV1
} from "@loom/sdk/recovery";

/**
 * What a guardian checks before signing to *stop* a recovery.
 *
 * The mirror of `prepareGuardianRecoveryReview`, and deliberately a separate
 * one. A guardian asked to cancel and a guardian asked to approve are being
 * asked opposite questions, and code that answered both would be one edit away
 * from answering the wrong one.
 *
 * The digest is recomputed rather than read from the request. It is the whole
 * of what the guardian signs, so taking the sender's word for it would let a
 * request display one thing and sign another.
 */
export interface GuardianCancellationReview {
  readonly request: CancelRequestV1;
  readonly capability: GuardianInviteV1;
  readonly digest: Hex;
  /** The recovery this signature would stop, rebuilt from live chain state. */
  readonly recoveryId: Hex;
}

export interface LiveCancellationState {
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly configVersion: bigint;
  readonly pending: {
    readonly pending: boolean;
    readonly oldValidatorsHash: Hex;
    readonly newValidator: Address;
    readonly initDataHash: Hex;
    readonly newGuardianRoot: Hex;
    readonly newGuardianThreshold: number;
    readonly configVersion: bigint;
    readonly nonce: bigint;
  };
}

export function prepareGuardianCancellationReview(input: {
  readonly request: CancelRequestV1;
  readonly capability: GuardianInviteV1;
  readonly live: LiveCancellationState;
}): GuardianCancellationReview {
  const { request, capability, live } = input;

  if (request.chainId !== capability.chainId || request.account.toLowerCase() !== capability.account.toLowerCase()) {
    throw new Error("This cancellation request belongs to another protected account.");
  }
  // Signing to stop a recovery that is not there would be a signature with
  // nothing to authorise -- and a request that claims one is lying about
  // something.
  if (!live.pending.pending) throw new Error("The chain holds no pending recovery for this account, so there is nothing to stop.");
  if (request.guardianRoot !== capability.guardianRoot || request.guardianRoot !== live.guardianRoot) {
    throw new Error("The cancellation request does not use the active guardian root.");
  }
  if (request.guardianThreshold !== capability.threshold || request.guardianThreshold !== live.guardianThreshold) {
    throw new Error("The cancellation request guardian threshold is stale.");
  }
  if (request.configVersion !== live.configVersion.toString()) {
    throw new Error("The cancellation request configuration is stale.");
  }
  if (request.nonce !== live.pending.nonce.toString()) {
    throw new Error("The cancellation request names a different recovery than the one now pending.");
  }
  if (!verifyGuardianProof({ root: live.guardianRoot, leaf: capability.guardian.leaf, proof: capability.proof })) {
    throw new Error("Your guardian capability no longer belongs to the active root.");
  }

  const recoveryId = createRecoveryId({
    account: request.account,
    oldValidatorsHash: live.pending.oldValidatorsHash,
    newValidator: live.pending.newValidator,
    initDataHash: live.pending.initDataHash,
    newGuardianRoot: live.pending.newGuardianRoot,
    newGuardianThreshold: live.pending.newGuardianThreshold,
    configVersion: live.pending.configVersion,
    nonce: live.pending.nonce
  });
  if (recoveryId !== request.recoveryId) {
    throw new Error("The cancellation request does not match the recovery the chain is holding.");
  }

  const digest = createRecoveryCancellationDigest({
    chainId: request.chainId,
    recoveryManager: request.recoveryManager,
    account: request.account,
    recoveryId,
    configVersion: request.configVersion,
    nonce: request.nonce
  });
  if (digest !== request.cancelDigest) {
    throw new Error("The cancellation request shows a digest it did not derive. Do not sign it.");
  }

  return Object.freeze({ request, capability, digest, recoveryId });
}

export function createGuardianCancellationResponse(input: {
  readonly review: GuardianCancellationReview;
  readonly signature: Hex;
  readonly signedAt: number;
}): CancelResponseV1 {
  const { request, capability, digest } = input.review;
  // As with an approval: the request's window binds, the invitation's does not.
  // Stopping a recovery is the more urgent of the two, and a guardian whose
  // invitation lapsed months ago is exactly who may need to object.
  if (input.signedAt >= request.expiresAt) {
    throw new Error("The cancellation request expired before signing.");
  }
  return createCancelResponse({
    recoveryId: request.recoveryId,
    chainId: request.chainId,
    account: request.account,
    cancelDigest: digest,
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
