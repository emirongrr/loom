import type { Address, Hex } from "@loom/core";

/**
 * Whether an accepted capability still speaks for the account it names.
 *
 * A capability is issued against one guardian set: a root, a threshold, and the
 * configuration version they were published under. The owner can rotate that
 * set at any time, and doing so is not an error -- it is how a guardian is
 * added or removed. But the capability held here does not change with it, and a
 * superseded one produces approvals the account will refuse.
 *
 * The guardian is the one person who cannot see this coming. They accepted an
 * invitation, and nothing on their side is told when it stops counting. So it
 * is read from the account rather than assumed, and stated plainly on the card.
 *
 * Every state here is a fact about the chain or the clock, never a stored flag:
 * a status written down at acceptance is exactly the thing that goes stale
 * without anyone noticing.
 */
export type CapabilityStanding =
  /** The account still publishes the set this capability was issued against. */
  | { readonly kind: "current" }
  /** The owner has rotated the guardian set; this capability no longer counts. */
  | { readonly kind: "superseded"; readonly detail: string }
  /** The account no longer has guardian recovery configured at all. */
  | { readonly kind: "recovery-off" }
  /** The account could not be read. Absence of an answer is not an answer. */
  | { readonly kind: "unreadable"; readonly detail: string };

export interface LiveAccountConfiguration {
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly configVersion: bigint;
  readonly recoveryConfigured: boolean;
}

export interface CapabilityFacts {
  readonly account: Address;
  readonly guardianRoot: Hex;
  readonly threshold: number;
  readonly configVersion: string;
  readonly expiresAt: number;
}

/**
 * Decided entirely against the account, never against a clock.
 *
 * The invitation carried an expiry, but that was the deadline for accepting the
 * link, not a lifetime for the leaf it delivered. The chain verifies an approval
 * against the guardian root and has no notion of when the invitation was sent,
 * so a lapsed one is not a dead capability -- and reporting it as one told a
 * guardian they could not help with an account they could.
 */
export function capabilityStanding(input: {
  readonly capability: CapabilityFacts;
  readonly live: LiveAccountConfiguration;
}): CapabilityStanding {
  const { capability, live } = input;
  if (!live.recoveryConfigured) return Object.freeze({ kind: "recovery-off" as const });

  if (capability.guardianRoot.toLowerCase() !== live.guardianRoot.toLowerCase()) {
    return Object.freeze({
      kind: "superseded" as const,
      detail: "The account's guardian set has been changed since this invitation was issued."
    });
  }
  // The root can match while the threshold or configuration version has moved,
  // and an approval is bound to all three. Reported separately because they
  // mean different things to whoever has to fix it.
  if (capability.threshold !== live.guardianThreshold) {
    return Object.freeze({
      kind: "superseded" as const,
      detail: `The account now needs ${live.guardianThreshold} approvals, not ${capability.threshold}.`
    });
  }
  if (capability.configVersion !== live.configVersion.toString()) {
    return Object.freeze({
      kind: "superseded" as const,
      detail: "The account's configuration has been replaced since this invitation was issued."
    });
  }
  return Object.freeze({ kind: "current" as const });
}

/** What the card says, in the guardian's terms rather than the protocol's. */
export function describeStanding(standing: CapabilityStanding): {
  readonly label: string;
  readonly tone: "good" | "warning";
  readonly detail: string;
} {
  switch (standing.kind) {
    case "current":
      return Object.freeze({
        label: "In force",
        tone: "good" as const,
        detail: "This account still publishes the guardian set you were invited into. Your approval would count."
      });
    case "superseded":
      return Object.freeze({
        label: "Superseded",
        tone: "warning" as const,
        detail: `${standing.detail} Ask the owner for a new invitation; approvals from this one would be refused.`
      });
    case "recovery-off":
      return Object.freeze({
        label: "Not in use",
        tone: "warning" as const,
        detail: "This account no longer has guardian recovery configured, so there is nothing to approve."
      });
    case "unreadable":
      return Object.freeze({
        label: "Not checked",
        tone: "warning" as const,
        detail: `${standing.detail} Nothing here is wrong as far as this device knows -- it simply could not ask the account.`
      });
  }
}
