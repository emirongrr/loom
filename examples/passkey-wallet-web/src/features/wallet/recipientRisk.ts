import type { Address } from "@loom/core";

/**
 * Recipient checks that run before a transfer is encoded.
 *
 * These are warnings, not refusals. A person may legitimately send to a
 * contract or to their own account, and a wallet that refuses on suspicion
 * teaches people to route around it. What a wallet owes them is the fact they
 * cannot see: that this address resembles one they know, or is not the kind of
 * destination they probably meant.
 */

export interface KnownAddress {
  readonly address: Address;
  readonly label: string;
  /** `contract` is a token or collection; `known` is one of the user's own. */
  readonly kind: "contract" | "known";
}

export type RecipientRisk =
  | { readonly kind: "self" }
  | { readonly kind: "burn" }
  | { readonly kind: "contract"; readonly label: string }
  | { readonly kind: "look-alike"; readonly similarTo: Address; readonly label: string };

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

/**
 * How many hex characters at each end must match for two addresses to be
 * treated as confusable.
 *
 * Address poisoning works because wallets truncate and people compare the ends.
 * Six each side is roughly what a truncated display shows; matching both ends
 * by chance is vanishingly unlikely, while matching one end is common enough
 * that warning on it would be noise — and a warning people learn to dismiss is
 * worse than none.
 */
const CONFUSABLE_EDGE = 6;

export function assessRecipient(input: {
  readonly recipient: string;
  readonly account: string;
  readonly known: readonly KnownAddress[];
}): readonly RecipientRisk[] {
  const recipient = input.recipient.toLowerCase();
  const risks: RecipientRisk[] = [];

  if (recipient === input.account.toLowerCase()) risks.push({ kind: "self" });
  if (recipient === ZERO_ADDRESS) risks.push({ kind: "burn" });

  for (const entry of input.known) {
    const candidate = entry.address.toLowerCase();
    if (candidate === recipient) {
      if (entry.kind === "contract") risks.push({ kind: "contract", label: entry.label });
      // A known address the user recognises is the good case; nothing to say.
      continue;
    }
    if (confusable(recipient, candidate)) {
      risks.push({ kind: "look-alike", similarTo: entry.address, label: entry.label });
    }
  }

  return Object.freeze(risks);
}

function confusable(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const head = 2 + CONFUSABLE_EDGE;
  return left.slice(0, head) === right.slice(0, head)
    && left.slice(-CONFUSABLE_EDGE) === right.slice(-CONFUSABLE_EDGE);
}
