import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256 } from "viem";
import type { AccountHandle } from "../types.ts";
import type { GuardianVaultRecord } from "./guardianVault.ts";
import { AppError } from "../domain/errors/appError.ts";

/**
 * Bind a capability to the local wallet that actually holds its guardian
 * credential. The vault may contain several local accounts, but switching
 * wallets must never make one wallet's relationships visible in another.
 */
export function guardianCapabilityBelongsToAccount(capability: GuardianInviteV1, account: AccountHandle): boolean {
  if (capability.chainId !== account.chainId) return false;
  const keyCommitment = capability.guardian.kind === "erc1271"
    ? keccak256(encodeAbiParameters([{ type: "address" }], [account.account]))
    : capability.guardian.kind === "p256"
      ? keccak256(encodeAbiParameters(
          [{ type: "bytes32", name: "x" }, { type: "bytes32", name: "y" }],
          [account.publicKey.x, account.publicKey.y]
        ))
      : null;
  return keyCommitment?.toLowerCase() === capability.guardian.keyCommitment.toLowerCase();
}

/**
 * Thrown as an `AppError` so the reason survives to the screen.
 *
 * A plain `Error` here reached the reader as "Capability could not be
 * accepted", because the generic fallback exists to stop arbitrary internals
 * being shown. This message is written for them and says exactly what to do:
 * a per-guardian invitation carries that guardian's proof and salt, so it can
 * only be accepted in the wallet whose passkey matches -- which is the
 * difference between a wrong wallet and a broken link.
 */
export function assertGuardianCapabilityMatchesAccount(capability: GuardianInviteV1, account: AccountHandle): void {
  if (!guardianCapabilityBelongsToAccount(capability, account)) {
    throw new AppError({
      code: "INVALID_INPUT",
      userMessage: capability.chainId !== account.chainId
        ? `This invitation is for chain ${capability.chainId}; this wallet is on chain ${account.chainId}.`
        : "This invitation was issued to a different wallet. It carries that guardian's own proof, so open the wallet it was sent to and accept it there.",
      retryable: false,
      stage: "validation"
    });
  }
}

export function guardianVaultRecordsForAccount(
  records: readonly GuardianVaultRecord[],
  account: AccountHandle
): readonly GuardianVaultRecord[] {
  return Object.freeze(records.filter(record => guardianCapabilityBelongsToAccount(record.capability, account)));
}

/** Recovery signing UI exists only for the open wallet's usable accepted capabilities. */
export function reviewableGuardianCapabilitiesForAccount(
  records: readonly GuardianVaultRecord[],
  account: AccountHandle,
  nowSeconds: number
): readonly GuardianVaultRecord[] {
  return Object.freeze(guardianVaultRecordsForAccount(records, account).filter(record =>
    record.status !== "stale"
    && record.status !== "removed"
    && record.capability.expiresAt > nowSeconds
  ));
}
