import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { RecoveryIntentBoardAbi, RecoveryManagerAbi } from "@loom/core/abi";
import type { Address, Hex } from "@loom/core";

/**
 * The transactions a recovery screen can ask for, built in one place.
 *
 * Components were encoding protocol calldata themselves: the announcement was
 * built twice in the same file, once for the external wallet and once for the
 * Loom wallet, and the two board publications were built inside their dialogs.
 * A mistake in any of them surfaces only when the chain refuses the call --
 * which is how a missing function on a deployed board reached a person as a
 * bundler declining to estimate gas.
 *
 * Here they are values: an address and calldata, returned by a pure function,
 * checkable without a browser and without a chain. Nothing in this file
 * decides whether a call *should* be made; the screens still do that, and the
 * contracts still re-verify everything when it arrives.
 */
export interface AccountCallRequest {
  readonly to: Address;
  readonly data: Hex;
}

/** The approval tuple both board entry points and the manager accept. */
export interface GuardianApprovalTuple {
  readonly verifier: Address;
  readonly keyCommitment: Hex;
  readonly salt: Hex;
  readonly signature: Hex;
  readonly proof: readonly Hex[];
}

/**
 * `keccak256(abi.encode(address[]))` over the validators a recovery replaces.
 * The manager and the board both identify a recovery partly by this, so it is
 * derived the same way in both places rather than passed between them.
 */
export function oldValidatorsHash(validators: readonly Address[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [[...validators]]));
}

export function announceRecovery(input: {
  readonly board: Address;
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly expiresAt: number;
}): AccountCallRequest {
  return Object.freeze({
    to: input.board,
    data: encodeFunctionData({
      abi: RecoveryIntentBoardAbi,
      functionName: "announce",
      args: [
        input.account, input.recoveryManager, input.oldValidatorsHash, input.newValidator,
        input.initDataHash, input.newGuardianRoot, input.newGuardianThreshold, input.expiresAt
      ]
    })
  });
}

/**
 * The board takes an array so it can reuse `GuardianVerificationLib`'s
 * calldata loop, and requires exactly one entry. `leaf` is derived on chain
 * and is not part of the struct, so it is not sent.
 */
export function publishApproval(input: {
  readonly board: Address;
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly approval: GuardianApprovalTuple;
}): AccountCallRequest {
  return Object.freeze({
    to: input.board,
    data: encodeFunctionData({
      abi: RecoveryIntentBoardAbi,
      functionName: "publishApproval",
      args: [
        input.account, input.recoveryManager, input.oldValidatorsHash, input.newValidator,
        input.initDataHash, input.newGuardianRoot, input.newGuardianThreshold, [tuple(input.approval)]
      ]
    })
  });
}

/**
 * A cancellation publication names no recovery of its own: the board reads the
 * pending record from the manager the account installed and derives the
 * identity and digest from it. That is why this takes so much less than
 * publishing an approval does.
 */
export function publishCancellation(input: {
  readonly board: Address;
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly approval: GuardianApprovalTuple;
}): AccountCallRequest {
  return Object.freeze({
    to: input.board,
    data: encodeFunctionData({
      abi: RecoveryIntentBoardAbi,
      functionName: "publishCancellation",
      args: [input.account, input.recoveryManager, [tuple(input.approval)]]
    })
  });
}

/**
 * Cancel with the account's own authority plus guardian support.
 *
 * The manager requires `msg.sender == account`, so this only counts when the
 * account itself makes the call. Requiring both prevents a compromised current
 * validator from indefinitely cancelling the recovery meant to replace it.
 */
export function cancelWithAccountAndGuardians(input: {
  readonly recoveryManager: Address;
  readonly account: Address;
  readonly approvals: readonly GuardianApprovalTuple[];
}): AccountCallRequest {
  return Object.freeze({
    to: input.recoveryManager,
    data: encodeFunctionData({
      abi: RecoveryManagerAbi,
      functionName: "cancelRecoveryWithAccountAndGuardians",
      args: [input.account, sortedTuples(input.approvals)]
    })
  });
}

/** Cancel at the full guardian threshold, from any sender at all. */
export function cancelWithGuardians(input: {
  readonly recoveryManager: Address;
  readonly account: Address;
  readonly approvals: readonly GuardianApprovalTuple[];
}): AccountCallRequest {
  return Object.freeze({
    to: input.recoveryManager,
    data: encodeFunctionData({
      abi: RecoveryManagerAbi,
      functionName: "cancelRecoveryWithGuardians",
      args: [input.account, sortedTuples(input.approvals)]
    })
  });
}

const tuple = (approval: GuardianApprovalTuple) => ({
  verifier: approval.verifier,
  keyCommitment: approval.keyCommitment,
  salt: approval.salt,
  signature: approval.signature,
  proof: [...approval.proof]
});

/**
 * `GuardianVerificationLib` walks the approvals expecting strictly increasing
 * leaves, and refuses the bundle otherwise. Sorting here means a screen cannot
 * produce a bundle the chain will reject for an ordering it never chose.
 */
function sortedTuples(approvals: readonly GuardianApprovalTuple[]) {
  return [...approvals]
    .map(approval => ({ ...tuple(approval), leaf: guardianOrderKey(approval) }))
    .sort((left, right) => left.leaf < right.leaf ? -1 : left.leaf > right.leaf ? 1 : 0)
    .map(({ leaf: _leaf, ...rest }) => rest);
}

/** The leaf the chain derives, recomputed here only to order the bundle. */
function guardianOrderKey(approval: GuardianApprovalTuple): string {
  return `${approval.verifier}${approval.keyCommitment}${approval.salt}`.toLowerCase();
}
