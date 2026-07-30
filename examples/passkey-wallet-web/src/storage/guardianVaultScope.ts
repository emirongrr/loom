import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256 } from "viem";
import type { AccountHandle } from "../types.ts";
import type { GuardianVaultRecord } from "./guardianVault.ts";

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

export function assertGuardianCapabilityMatchesAccount(capability: GuardianInviteV1, account: AccountHandle): void {
  if (!guardianCapabilityBelongsToAccount(capability, account)) {
    throw new Error("This invitation belongs to a different guardian wallet. Open that wallet before accepting it.");
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
