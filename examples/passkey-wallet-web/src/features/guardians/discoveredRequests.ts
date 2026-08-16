import type { Address, Hex } from "@loom/core";
import {
  createRecoveryRequest,
  type DiscoveredRecoveryAnnouncement,
  type DiscoveredRecoveryApproval,
  type GuardianInviteV1,
  type RecoveryRequestV1
} from "@loom/sdk/recovery";
import { prepareGuardianRecoveryReview } from "../recovery/recoveryApproval.ts";

/**
 * Turn raw board logs into what a guardian is allowed to see.
 *
 * The distinction this module exists to draw is `trust`:
 *
 * - `"detected"` — something was published naming this account. Anyone can emit
 *   that, so it is shown as a lead, never as a request to act on, and carries no
 *   `request` to review.
 * - `"verified"` — the announced parameters re-derive exactly against the
 *   account's live guardian root, threshold, configuration version, and
 *   validator set, and this guardian's own proof still belongs to that root.
 *
 * Verification reuses `prepareGuardianRecoveryReview`, the same check a request
 * pasted from a QR code or file goes through, so a chain-discovered request and
 * a hand-delivered one are held to one standard rather than two.
 *
 * Nothing here is authority. A `"verified"` view means "worth showing a human",
 * and the guardian still compares the six-digit code out of band before signing.
 */

export type DiscoveredRequestTrust = "detected" | "verified";

export interface DiscoveredRequestView {
  readonly key: string;
  readonly recoveryId: Hex;
  readonly account: Address;
  readonly chainId: number;
  readonly capabilityId: Hex;
  readonly trust: DiscoveredRequestTrust;
  readonly threshold: number;
  readonly publishedApprovals: number;
  readonly alreadyPublishedByMe: boolean;
  readonly newValidator?: Address;
  readonly expiresAt?: number;
  /** Present only when `trust === "verified"`. */
  readonly request?: RecoveryRequestV1;
  /** Present only when `trust === "detected"`; a safe, human-readable reason. */
  readonly issue?: string;
}

export interface LiveGuardianAccountState {
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly configVersion: bigint;
  readonly validators: readonly Address[];
  readonly recoveryConfigured: boolean;
}

/** The canonical request format caps a request's lifetime at seven days. */
const MAX_REQUEST_LIFETIME = 604_800;

export function classifyDiscoveredRequests(input: {
  readonly announcements: readonly DiscoveredRecoveryAnnouncement[];
  readonly approvals: readonly DiscoveredRecoveryApproval[];
  readonly capability: GuardianInviteV1;
  readonly live: LiveGuardianAccountState;
  readonly recoveryManager: Address;
  readonly board: Address;
  readonly now: number;
}): readonly DiscoveredRequestView[] {
  const { capability, live, now } = input;
  const mine = capability.guardian.leaf.toLowerCase();

  // A log naming another account or another manager is not this guardian's
  // business at all, so it is dropped rather than shown as a weak lead.
  const relevant = <T extends { account: Address; recoveryManager: Address }>(entry: T): boolean =>
    entry.account.toLowerCase() === capability.account.toLowerCase()
    && entry.recoveryManager.toLowerCase() === input.recoveryManager.toLowerCase();

  const announcements = input.announcements.filter(relevant);
  const approvals = input.approvals.filter(relevant);

  const approvalsById = new Map<string, DiscoveredRecoveryApproval[]>();
  for (const entry of approvals) {
    const key = entry.recoveryId.toLowerCase();
    approvalsById.set(key, [...(approvalsById.get(key) ?? []), entry]);
  }

  const views: DiscoveredRequestView[] = [];
  const seen = new Set<string>();

  for (const entry of announcements) {
    const id = entry.recoveryId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    views.push(viewFor(entry, approvalsById.get(id) ?? []));
  }

  // A guardian may have published before anyone announced. Surfacing that is the
  // difference between "nothing is happening" and "someone is recovering this
  // account and you were not told" — the second is worth a human's attention
  // even though there is nothing here to review.
  for (const [id, entries] of approvalsById) {
    if (seen.has(id)) continue;
    seen.add(id);
    const first = entries[0]!;
    views.push(Object.freeze({
      key: `${capability.chainId}:${capability.account.toLowerCase()}:${id}`,
      recoveryId: first.recoveryId,
      account: capability.account,
      chainId: capability.chainId,
      capabilityId: capability.capabilityId,
      trust: "detected" as const,
      threshold: live.guardianThreshold,
      publishedApprovals: entries.filter(item => item.confirmed).length,
      alreadyPublishedByMe: entries.some(item => item.guardianLeaf.toLowerCase() === mine),
      issue: "A guardian approval was published without a matching request. Ask the person recovering this account to send you the request."
    }));
  }

  return Object.freeze(views);

  function viewFor(
    entry: DiscoveredRecoveryAnnouncement,
    entries: readonly DiscoveredRecoveryApproval[]
  ): DiscoveredRequestView {
    const base = {
      key: `${capability.chainId}:${capability.account.toLowerCase()}:${entry.recoveryId.toLowerCase()}`,
      recoveryId: entry.recoveryId,
      account: capability.account,
      chainId: capability.chainId,
      capabilityId: capability.capabilityId,
      threshold: live.guardianThreshold,
      publishedApprovals: entries.filter(item => item.confirmed).length,
      alreadyPublishedByMe: entries.some(item => item.guardianLeaf.toLowerCase() === mine),
      newValidator: entry.newValidator,
      expiresAt: Number(entry.expiresAt)
    };

    const detected = (issue: string): DiscoveredRequestView =>
      Object.freeze({ ...base, trust: "detected" as const, issue });

    if (!live.recoveryConfigured) return detected("This account no longer has guardian recovery configured.");

    const expiresAt = Number(entry.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return detected("This recovery request has expired.");
    // `expiresAt` is an unvalidated hint in the contract, so an absurd value is
    // rejected here rather than clamped into something that looks reasonable.
    if (expiresAt - now > MAX_REQUEST_LIFETIME) {
      return detected("This request claims an expiry beyond the supported request lifetime.");
    }

    let request: RecoveryRequestV1;
    try {
      request = createRecoveryRequest({
        requestId: entry.recoveryId,
        chainId: capability.chainId,
        account: capability.account,
        recoveryManager: input.recoveryManager,
        guardianRoot: live.guardianRoot,
        guardianThreshold: live.guardianThreshold,
        configVersion: live.configVersion.toString(),
        nonce: entry.nonce.toString(),
        newValidator: entry.newValidator,
        initDataHash: entry.initDataHash,
        newGuardianRoot: entry.newGuardianRoot,
        newGuardianThreshold: entry.newGuardianThreshold,
        createdAt: Math.max(1, expiresAt - MAX_REQUEST_LIFETIME),
        expiresAt
      });
      // The authoritative check: this re-derives the recovery id from the live
      // validator set and re-checks the guardian proof against the live root, so
      // an announcement that disagrees with the chain can never reach a signing
      // screen.
      const review = prepareGuardianRecoveryReview({ request, capability, live });
      // `oldValidatorsHash` is not part of the request format — it is derived
      // from live validators — so the announced copy is never covered by the
      // check above. The board derives both from the same arguments, but this
      // decoder reads them as independent log fields, and a displayed value that
      // disagrees with the chain must not be shown beside a verified badge.
      if (review.oldValidatorsHash.toLowerCase() !== entry.oldValidatorsHash.toLowerCase()) {
        return detected("This request does not match the account's current validator set.");
      }
    } catch {
      // The reason is deliberately generic. A precise diagnosis here would
      // describe another party's account state to whoever is watching.
      return detected("This request does not match the account's current recovery state.");
    }

    return Object.freeze({ ...base, trust: "verified" as const, request });
  }
}
