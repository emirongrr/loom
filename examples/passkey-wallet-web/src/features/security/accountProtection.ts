/**
 * What the account's on-chain state means for the person who owns it.
 *
 * The security screen used to print the chain's own fields: config version,
 * validators installed, guardian threshold, freeze, pending recovery. Two of
 * those are diagnostics no owner can act on, one repeats the posture card
 * directly above it in plainer words, and the remaining two say "None" and
 * "No" almost always -- so the panel spent most of its space telling people
 * that nothing was wrong, in a vocabulary that made it hard to be sure.
 *
 * This answers three questions instead, in the order they matter: is the
 * account protected, is anything happening to it, and can it act right now.
 * Detail that only helps when something is being diagnosed stays available,
 * but it does not lead.
 */
export type ProtectionTone = "protected" | "attention" | "urgent";

export interface ProtectionSignal {
  readonly id: "guardians" | "pending-recovery" | "freeze";
  readonly tone: ProtectionTone;
  readonly title: string;
  readonly detail: string;
  /** Present when the owner has something to do about it. */
  readonly action?: "add-guardians" | "review-recovery";
}

export interface AccountProtection {
  /** The shield: green when the account can be recovered, red when it cannot. */
  readonly guarded: boolean;
  readonly signals: readonly ProtectionSignal[];
  /** True when nothing is happening to the account beyond ordinary use. */
  readonly quiet: boolean;
}

export function describeAccountProtection(input: {
  readonly guardianThreshold: number;
  readonly recoveryConfigured: boolean;
  readonly freezeActive: boolean;
  readonly pendingRecovery: boolean;
}): AccountProtection {
  const guarded = input.recoveryConfigured && input.guardianThreshold > 0;
  const signals: ProtectionSignal[] = [];

  signals.push(guarded
    ? Object.freeze({
      id: "guardians" as const,
      tone: "protected" as const,
      title: `Recoverable with ${count(input.guardianThreshold)}`,
      detail: "If this device's passkey is lost, your guardians can move the account to a new one after a three-day delay."
    })
    : Object.freeze({
      id: "guardians" as const,
      tone: "urgent" as const,
      title: "Not recoverable",
      detail: "No guardians are configured, so losing this device's passkey means losing the account.",
      action: "add-guardians" as const
    }));

  // Only shown when true. A row that reads "None" every day teaches people to
  // stop reading it, which is the opposite of what it is for.
  if (input.pendingRecovery) {
    signals.push(Object.freeze({
      id: "pending-recovery" as const,
      tone: "urgent" as const,
      title: "Someone is recovering this account",
      detail: "When it completes, control moves to a new passkey and this one stops working. If you did not start it, act now.",
      action: "review-recovery" as const
    }));
  }

  if (input.freezeActive) {
    signals.push(Object.freeze({
      id: "freeze" as const,
      tone: "attention" as const,
      title: "Frozen by your guardians",
      detail: "Spending is blocked until the freeze expires by contract. Recovery is unaffected."
    }));
  }

  return Object.freeze({
    guarded,
    signals: Object.freeze(signals),
    quiet: !input.pendingRecovery && !input.freezeActive
  });
}

const count = (value: number): string => `${value} guardian${value === 1 ? "" : "s"}`;
