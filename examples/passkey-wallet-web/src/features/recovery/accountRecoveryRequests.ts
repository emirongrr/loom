import type { Address } from "@loom/core";
import type { RecoverySession } from "./recoverySession";
import type { PublishedRecoveryValidator } from "./existingPublications";
import { mediumAddress } from "../../components/address.ts";

/**
 * Every recovery in flight for one account, gathered from the places they
 * actually live, with the next step each one is waiting on.
 *
 * A recovery is not one object in one place. Part of it is an encrypted session
 * on this device, part is a validator published on chain by whoever paid the
 * gas, and part is a record the manager only writes once guardians have
 * approved. The interface used to show each of those in a different corner --
 * a warning paragraph in the passkey step, an unfiltered session list, a manual
 * lookup box -- and left the reader to work out that they were the same
 * recovery, or three different ones.
 *
 * Collecting them means a reader who enters an account address is told what is
 * already underway for it, and can carry the right one forward instead of
 * starting a fourth.
 *
 * Nothing here reads the chain or touches storage. It is given what the page
 * already fetched and decides only what is true and what comes next, so the
 * decision can be tested without a network.
 */

/** What this request is waiting for, expressed as the action that unblocks it. */
export type RecoveryNextStep =
  /** A local session exists: open it to collect approvals, propose, or execute. */
  | { readonly kind: "open-session"; readonly sessionId: string; readonly label: string }
  /** A published validator this device can still turn into a guardian request. */
  | { readonly kind: "request-approvals"; readonly label: string }
  /** A prepared passkey whose validator is not on chain yet. */
  | { readonly kind: "publish-validator"; readonly label: string }
  /** Nothing this device can do, and why. */
  | { readonly kind: "blocked"; readonly reason: string }
  /** A duplicate request that can be deleted without losing anything. */
  | { readonly kind: "discard-session"; readonly sessionId: string; readonly label: string };

export interface AccountRecoveryRequest {
  readonly id: string;
  readonly title: string;
  /** Where this recovery has got to, in the reader's terms. */
  readonly status: string;
  readonly detail: string;
  readonly next: RecoveryNextStep;
  /** True when this is the entry the reader is most likely to want. */
  readonly primary: boolean;
}

/**
 * Short by design: these render as chips, and the chip style capitalises every
 * word. A sentence there becomes a headline shouting at the reader.
 */
const SESSION_STAGE: Readonly<Record<RecoverySession["stage"], string>> = Object.freeze({
  "request-created": "Ready to send",
  collecting: "Collecting approvals",
  "ready-to-propose": "Threshold reached",
  "delay-active": "Delay running",
  "ready-to-execute": "Ready to execute",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
  blocked: "Blocked"
});

/** Stages that are over. They are still shown, but never as the thing to do next. */
const FINISHED = new Set<RecoverySession["stage"]>(["completed", "cancelled", "expired"]);

export interface OnChainPendingRecovery {
  readonly pending: boolean;
  readonly newValidator: Address;
  readonly status: "none" | "unknown" | "delay-active" | "ready" | "expired";
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
}

/**
 * Order matters more than completeness here. The reader wants the one thing
 * they can act on, so anything actionable sorts above anything finished, and
 * a session this device can drive sorts above a publication it cannot.
 */
export function collectAccountRecoveryRequests(input: {
  readonly chainId: number;
  readonly account: Address;
  readonly sessions: readonly RecoverySession[];
  readonly published?: readonly PublishedRecoveryValidator[];
  /**
   * Every validator a local draft resolved to, not just the first.
   *
   * A device can hold more than one: publishing is permissionless and a reader
   * who tried twice paid twice. Reporting only the first told them the other
   * publication belonged to someone else's device.
   */
  readonly restored?: readonly { readonly validator: Address; readonly published: boolean }[];
  readonly pending?: OnChainPendingRecovery;
  /**
   * Encrypted drafts this device holds for the account that would not open.
   *
   * Matching a publication to a passkey needs the draft that produced it: the
   * validator address is derived from its init data, and the passkey sitting in
   * the browser's own store proves nothing about which validator it made. So a
   * device with unreadable drafts is not a device without the passkey, and
   * saying "not on this device" there sends the reader to pay for another
   * publication to work around a storage problem.
   */
  readonly unreadableDrafts?: number;
}): readonly AccountRecoveryRequest[] {
  const account = input.account.toLowerCase();
  const unreadable = input.unreadableDrafts ?? 0;
  const requests: AccountRecoveryRequest[] = [];

  const mine = input.sessions.filter(session =>
    session.request.chainId === input.chainId && session.request.account.toLowerCase() === account
  );
  const claimed = new Set<string>();

  // Two live requests for one validator are not two chances. Each rotates to a
  // fresh guardian set, so their digests differ and an approval collected for
  // one will not verify against the other; and the recovery nonce admits a
  // single pending request, so only one could ever be proposed. The first is
  // the one to keep -- any approvals already gathered belong to it.
  const liveByValidator = new Map<string, string>();
  for (const session of mine) {
    if (FINISHED.has(session.stage)) continue;
    const key = session.request.newValidator.toLowerCase();
    if (!liveByValidator.has(key)) liveByValidator.set(key, session.id);
  }

  // The chain owns whether a recovery has been proposed, and a local record can
  // be behind it: a session that was proposed still reads "ready to send" until
  // this device happens to refresh it. Offering to send a request whose
  // approvals the manager has already accepted -- it refuses to record one
  // below the threshold -- sends guardians work that cannot count.
  const proposedValidator = input.pending?.pending
    ? input.pending.newValidator.toLowerCase()
    : undefined;

  for (const session of mine) {
    claimed.add(session.request.newValidator.toLowerCase());
    const finished = FINISHED.has(session.stage);
    const proposed = proposedValidator === session.request.newValidator.toLowerCase();
    const duplicate = !finished && !proposed
      && liveByValidator.get(session.request.newValidator.toLowerCase()) !== session.id;
    const approvals = `${session.responses.length} of ${session.request.guardianThreshold} guardian approvals`;
    requests.push(Object.freeze({
      id: `session:${session.id}`,
      title: `Recovery ${session.request.humanCode}`,
      status: proposed ? onChainStatus(input.pending!.status) : duplicate ? "Duplicate" : SESSION_STAGE[session.stage],
      detail: proposed
        ? `The guardians approved this and the manager recorded it, so the request is finished with. New validator`
          + ` ${mediumAddress(session.request.newValidator)}.`
        : duplicate
        ? `A second request for validator ${mediumAddress(session.request.newValidator)}. Only one recovery can be proposed,`
          + ` and an approval given for one request does not verify against another, so this one cannot be used`
          + ` alongside the first. It holds ${session.responses.length} approval(s).`
        : finished
          ? `New validator ${mediumAddress(session.request.newValidator)}.`
          : `${approvals}. New validator ${mediumAddress(session.request.newValidator)}.`,
      next: proposed
        ? { kind: "open-session" as const, sessionId: session.id, label: "Open" }
        : duplicate
        ? { kind: "discard-session" as const, sessionId: session.id, label: "Discard this duplicate" }
        : finished
        ? { kind: "blocked" as const, reason: "This request is closed. Nothing further can be done with it." }
        : {
          kind: "open-session" as const,
          sessionId: session.id,
          label: session.stage === "request-created" || session.stage === "collecting"
            ? "Send to guardians"
            : "Open"
        },
      primary: !finished && !duplicate
    }));
  }

  // Published validators this device holds the draft for, with no session yet:
  // the gas is already spent and the only thing missing is the request the
  // guardians sign. Offering that directly is the difference between finishing
  // a recovery and paying to start another.
  let offered = 0;
  for (const entry of input.restored ?? []) {
    const validator = entry.validator.toLowerCase();
    if (claimed.has(validator)) continue;
    claimed.add(validator);
    // Only one recovery can ever be proposed for an account, so a second held
    // validator is a real thing the reader owns and a real thing they cannot
    // also use. Both halves have to be said.
    const spare = offered > 0;
    offered += 1;
    requests.push(Object.freeze({
      id: `draft:${validator}`,
      title: "Recovery passkey on this device",
      status: spare ? "Held, cannot also be used" : entry.published ? "Needs a request" : "Not published",
      detail: spare
        ? `Validator ${mediumAddress(entry.validator)} is also on this device. Only one recovery can be proposed for this`
          + ` account, so proposing the one above leaves this one unused and its gas unrecoverable.`
        : entry.published
          ? `Validator ${mediumAddress(entry.validator)} is live on chain. It needs a guardian request before it can be proposed.`
          : `Validator ${mediumAddress(entry.validator)} is prepared. Publishing it is permissionless and grants no account authority.`,
      next: spare
        ? { kind: "blocked" as const, reason: "Nothing to do with this one unless the recovery above is abandoned." }
        : entry.published
          ? { kind: "request-approvals" as const, label: "Create guardian request" }
          : { kind: "publish-validator" as const, label: "Publish validator" },
      primary: !spare
    }));
  }

  if (input.pending?.pending) {
    const validator = input.pending.newValidator.toLowerCase();
    // Claimed before the publication loop runs, so a validator that is both
    // published and proposed is reported as the proposal. The proposal is the
    // stronger fact -- guardians have already approved it and it only needs
    // the delay -- and reporting it as "published elsewhere" buried the one
    // thing the reader could act on.
    if (!claimed.has(validator)) {
      claimed.add(validator);
      requests.push(Object.freeze({
        id: `pending:${validator}`,
        title: "Recovery proposed on chain",
        status: onChainStatus(input.pending.status),
        detail: `The guardians have already approved a recovery to ${mediumAddress(input.pending.newValidator)}. Anyone can`
          + ` execute it once the delay elapses; no session on this device is required.`,
        next: {
          kind: "blocked" as const,
          reason: "Finish this recovery below. Execution needs no session and no passkey here -- only gas."
        },
        primary: false
      }));
    }
  }

  for (const entry of input.published ?? []) {
    const validator = entry.validator.toLowerCase();
    if (claimed.has(validator)) continue;
    claimed.add(validator);
    requests.push(Object.freeze({
      id: `published:${validator}`,
      title: "Recovery passkey published elsewhere",
      status: "Not on this device",
      detail: `Validator ${mediumAddress(entry.validator)} was published at block ${entry.blockNumber}. The gas for it is`
        + ` already spent, and it can still be turned into a guardian request -- but only from a device that can`
        + ` name it.`,
      next: {
        kind: "blocked" as const,
        reason: unreadable > 0
          ? `This device holds ${unreadable} saved recovery draft${unreadable === 1 ? "" : "s"} for this account`
            + ` that could not be opened, so none could be matched to this publication. The passkey may still be`
            + ` here; the draft that names it is what is missing.`
          : "No encrypted draft on this device names this validator. Matching a publication needs the draft that"
            + " produced it, not the passkey alone."
      },
      primary: false
    }));
  }

  return Object.freeze(requests);
}

function onChainStatus(status: OnChainPendingRecovery["status"]): string {
  return ({
    none: "No pending record",
    unknown: "Timing unread",
    "delay-active": "Delay running",
    ready: "Ready to execute",
    expired: "Window closed"
  })[status];
}
