import type { Address, Hex } from "@loom/core";
import {
  createGuardianInvite,
  createGuardianLeaf,
  type GuardianInviteV1
} from "@loom/sdk/recovery";
import { planGuardianChange, type RosterEntry } from "./guardianPlan.ts";
import type { OnChainGuardians } from "./guardianStatus.ts";

/** Least-disclosure labels shared by owner and guardian views. */
export const GUARDIAN_ACCOUNT_LABEL = "Protected account";
export const GUARDIAN_ISSUER_LABEL = "Account owner";

/**
 * Mint one least-disclosure capability only from the roster that reproduces
 * the account's currently active authority. A draft, stale backup, or pending
 * guardian epoch must never be presented as usable recovery authority.
 */
export function createActiveGuardianInvitation(input: {
  readonly entries: readonly RosterEntry[];
  readonly guardianId: string;
  readonly setVersion: number;
  readonly onChain: OnChainGuardians;
  readonly chainId: number;
  readonly account: Address | string;
  readonly capabilityId: Hex;
  readonly expiresAt: number;
}): GuardianInviteV1 {
  if (!input.onChain.recoveryConfigured) {
    throw new Error("An invitation cannot be created while the recovery module is not active.");
  }
  const target = input.entries.find(entry => entry.id === input.guardianId);
  if (!target) throw new Error("That guardian is not in the active local roster.");

  const set = planGuardianChange({
    current: [],
    next: input.entries,
    threshold: input.onChain.threshold
  }).set;
  if (set.root.toLowerCase() !== input.onChain.root.toLowerCase()) {
    throw new Error("This device's guardian list does not match the active guardian root.");
  }

  const guardianLeaf = createGuardianLeaf(target.descriptor);
  if (!set.guardians.some(guardian => guardian.leaf === guardianLeaf)) {
    throw new Error("That guardian does not belong to the active guardian set.");
  }

  return createGuardianInvite({
    set,
    guardianLeaf,
    chainId: input.chainId,
    account: input.account as Address,
    accountAlias: GUARDIAN_ACCOUNT_LABEL,
    issuerLabel: GUARDIAN_ISSUER_LABEL,
    guardianSetVersion: Math.max(1, input.setVersion),
    configVersion: input.onChain.configVersion,
    capabilityId: input.capabilityId,
    expiresAt: input.expiresAt
  });
}
