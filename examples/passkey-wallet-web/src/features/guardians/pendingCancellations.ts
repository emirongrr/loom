import { createCancelRequest, createRecoveryId, type CancelRequestV1, type GuardianInviteV1 } from "@loom/sdk/recovery";
import type { Address } from "@loom/core";

/**
 * Recoveries pending against the accounts this guardian protects.
 *
 * Nobody has to send a guardian a cancellation request, because every field of
 * one already exists on chain: the recovery being stopped, the configuration
 * version, the nonce, the guardian root and threshold, and the manager that
 * will check them. The guardian's own device rebuilds it from what the chain
 * says, which is also the only version worth signing -- a request that arrived
 * from someone else would have to be checked against exactly this anyway.
 *
 * Discovery reads only the accounts in the local guardian list. Nothing on
 * chain records who protects whom, and this must not become the thing that
 * does: the reads are ordinary state reads for accounts this device already
 * knew about.
 *
 * A pending recovery is not evidence of theft. Most are genuine, and stopping
 * one strands the owner it was meant to help. So this reports what is pending
 * and leaves the judgement where it belongs -- with the guardian, after they
 * have spoken to the owner.
 */
export interface PendingCancellationView {
  readonly account: Address;
  readonly capability: GuardianInviteV1;
  readonly request: CancelRequestV1;
  readonly newValidator: Address;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly phase: "delay" | "executable" | "expired";
  readonly guardianThreshold: number;
}

export interface PendingRecoveryState {
  readonly pending: boolean;
  readonly oldValidatorsHash: `0x${string}`;
  readonly newValidator: Address;
  readonly initDataHash: `0x${string}`;
  readonly newGuardianRoot: `0x${string}`;
  readonly newGuardianThreshold: number;
  readonly configVersion: bigint;
  readonly nonce: bigint;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly chainTimestamp?: bigint | undefined;
}

export interface ProtectedAccountState {
  readonly guardianRoot: `0x${string}`;
  readonly guardianThreshold: number;
  readonly configVersion: bigint;
  readonly recoveryConfigured: boolean;
}

/**
 * Build the view for one protected account, or null when there is nothing to
 * stop. Separated from the reads so the decision is testable without a chain.
 */
export function describePendingCancellation(input: {
  readonly capability: GuardianInviteV1;
  readonly recoveryManager: Address;
  readonly live: ProtectedAccountState;
  readonly pending: PendingRecoveryState;
  readonly nowSeconds: number;
}): PendingCancellationView | null {
  const { capability, live, pending } = input;
  if (!pending.pending || !live.recoveryConfigured) return null;

  // A capability that no longer matches the account's live configuration
  // cannot produce a signature the manager will accept, so offering the button
  // would be offering a dead end.
  if (capability.guardianRoot !== live.guardianRoot) return null;
  if (capability.threshold !== live.guardianThreshold) return null;
  if (capability.configVersion !== live.configVersion.toString()) return null;

  const account = capability.account;
  const recoveryId = createRecoveryId({
    account,
    oldValidatorsHash: pending.oldValidatorsHash,
    newValidator: pending.newValidator,
    initDataHash: pending.initDataHash,
    newGuardianRoot: pending.newGuardianRoot,
    newGuardianThreshold: pending.newGuardianThreshold,
    configVersion: pending.configVersion,
    nonce: pending.nonce
  });
  const now = pending.chainTimestamp === undefined ? BigInt(input.nowSeconds) : pending.chainTimestamp;

  return Object.freeze({
    account,
    capability,
    newValidator: pending.newValidator,
    readyAt: pending.readyAt,
    expiresAt: pending.expiresAt,
    guardianThreshold: live.guardianThreshold,
    phase: now > pending.expiresAt ? "expired" : now >= pending.readyAt ? "executable" : "delay",
    request: createCancelRequest({
      recoveryId,
      chainId: capability.chainId,
      account,
      recoveryManager: input.recoveryManager,
      guardianRoot: live.guardianRoot,
      guardianThreshold: live.guardianThreshold,
      configVersion: pending.configVersion.toString(),
      nonce: pending.nonce.toString(),
      createdAt: Number(now),
      // Bounded by the recovery's own window while it can still execute, so a
      // signature never outlives what it authorises. Once that window has
      // closed the recovery does not go away -- it keeps the slot, and no new
      // recovery can be proposed until it is cancelled -- so cancelling it
      // stays meaningful and the request gets an ordinary lifetime.
      expiresAt: cancellationHorizon(Number(now), Number(pending.expiresAt))
    })
  });
}

/** One entry per protected account, keeping the first capability for each. */
export function distinctProtectedAccounts(
  records: readonly { readonly capability: GuardianInviteV1 }[],
  chainId: number
): readonly GuardianInviteV1[] {
  const seen = new Map<string, GuardianInviteV1>();
  for (const record of records) {
    if (record.capability.chainId !== chainId) continue;
    const key = record.capability.account.toLowerCase();
    if (!seen.has(key)) seen.set(key, record.capability);
  }
  return Object.freeze([...seen.values()]);
}

/** A day, or the rest of the execution window when that is shorter. */
export function cancellationHorizon(nowSeconds: number, recoveryExpiresAt: number): number {
  const day = nowSeconds + 86_400;
  return recoveryExpiresAt > nowSeconds ? Math.min(day, recoveryExpiresAt) : day;
}

/**
 * A stable identity for "which accounts does this guardian protect".
 *
 * Effects that read the chain must key off this rather than off the array of
 * capabilities. That array is rebuilt on every render, so depending on it made
 * the discovery effect re-run on every render -- and because its first act is
 * to set a loading state, each run caused another render. The list sat on
 * "Reading the chain" forever and the test process died of heap exhaustion
 * after allocating four gigabytes, with every test still reported as passing.
 */
export function protectedAccountsKey(records: readonly { readonly capability: GuardianInviteV1 }[]): string {
  return records
    .map(record => `${record.capability.chainId}:${record.capability.account.toLowerCase()}`)
    .sort()
    .join(",");
}
