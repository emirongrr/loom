import type { Address } from "@loom/core";
import { cancellationQuorum } from "../recovery/cancellationQuorum.ts";

/**
 * What an account owner is told when someone has started recovering their
 * account.
 *
 * A recovery replaces every validator on the account. The owner is the one
 * person who can tell whether it is theirs, and until now the wallet showed
 * them nothing: the first sign would have been losing the account. So this is
 * shown wherever the account is opened, not filed under a settings page.
 *
 * It does not tell them they can stop it alone, because they cannot. Cancelling
 * takes the account plus one fewer than the guardian threshold, or the full
 * threshold of guardians without the account (ADR-0023). That is deliberate: an
 * attacker holding the key must not be able to block a recovery the guardians
 * genuinely approved. Telling an owner otherwise would send them to a button
 * that cannot work while the clock runs.
 */
export type PendingRecoveryNotice =
  | { readonly kind: "none" }
  | {
    readonly kind: "pending";
    readonly urgency: "delay" | "executable" | "expired";
    readonly headline: string;
    readonly detail: string;
    readonly cancellation: string;
    readonly newValidator: Address;
  };

export function describePendingRecovery(input: {
  readonly pending: boolean;
  readonly newValidator: Address;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly guardianThreshold: number;
  readonly nowSeconds: bigint;
}): PendingRecoveryNotice {
  if (!input.pending || input.readyAt === 0n) return Object.freeze({ kind: "none" as const });

  const cancellation = cancellationSentence(input.guardianThreshold);

  if (input.nowSeconds > input.expiresAt) {
    return Object.freeze({
      kind: "pending" as const,
      urgency: "expired" as const,
      headline: "A recovery was started against this account and has expired.",
      detail: "Its execution window closed, so it can no longer take the account. It still occupies the recovery"
        + " slot until it is cancelled, which means no new recovery can be proposed -- including one you want.",
      cancellation,
      newValidator: input.newValidator
    });
  }

  if (input.nowSeconds >= input.readyAt) {
    return Object.freeze({
      kind: "pending" as const,
      urgency: "executable" as const,
      headline: "A recovery of this account can be executed right now.",
      detail: `The delay has passed. Anyone can complete it, and the moment they do, control moves to`
        + ` ${short(input.newValidator)} and this wallet's key stops working. If this is not yours, act now.`,
      cancellation,
      newValidator: input.newValidator
    });
  }

  return Object.freeze({
    kind: "pending" as const,
    urgency: "delay" as const,
    headline: "Someone has started recovering this account.",
    detail: `Your guardians approved it, and it becomes executable ${when(input.readyAt - input.nowSeconds)}.`
      + ` When it executes, control moves to ${short(input.newValidator)} and this wallet's key stops working.`
      + ` If you started it, there is nothing to do.`,
    cancellation,
    newValidator: input.newValidator
  });
}


/**
 * How cancelling actually works, in a sentence the reader can act on. The rule
 * itself lives in [[cancellationQuorum]] because it was written out by hand in
 * two screens and was wrong in both.
 */
function cancellationSentence(threshold: number): string {
  const quorum = cancellationQuorum(threshold);
  const reason = " One person cannot cancel a recovery alone -- if they could, anyone holding a stolen key could"
    + " block the guardians who were trying to take the account back.";
  return `Stopping ${quorum.sentence.replace(/^it /, "it ")}.` + reason;
}

const short = (value: string): string => `${value.slice(0, 10)}…${value.slice(-6)}`;

/** Coarse on purpose: the decision is "is there time", not "how many seconds". */
function when(seconds: bigint): string {
  if (seconds < 3600n) return "in under an hour";
  if (seconds < 86_400n) return `in about ${Number(seconds / 3600n)} hour(s)`;
  return `in about ${Number(seconds / 86_400n)} day(s)`;
}
