import type { Address } from "@loom/core";
import {
  createRecoveryIntentBoardReader,
  reconcileRecoveryDiscovery,
  type GuardianInviteV1,
  type RecoveryDiscoverySnapshot,
  type RecoveryLogTransport
} from "@loom/sdk/recovery";
import { classifyDiscoveredRequests, type DiscoveredRequestView, type LiveGuardianAccountState } from "./discoveredRequests.ts";

/**
 * Bind board discovery to the accounts this guardian actually holds a capability
 * for. Nothing is enumerated: the query set comes from the local vault, so the
 * chain is never asked "which accounts does this person protect".
 */

export interface GuardianDiscoveryResult {
  readonly requests: readonly DiscoveredRequestView[];
  /** Guardian leaves whose published approval disappeared in a reorg. */
  readonly rolledBack: readonly string[];
  readonly snapshots: Readonly<Record<string, RecoveryDiscoverySnapshot>>;
  /** Set when discovery could not run. The manual paths remain available. */
  readonly unavailable?: string;
}

export interface GuardianDiscoveryInput {
  readonly capabilities: readonly GuardianInviteV1[];
  readonly board?: Address;
  readonly recoveryManager?: Address;
  readonly chainId: number;
  readonly logTransport?: RecoveryLogTransport;
  readonly inspect: (account: Address) => Promise<{
    readonly guardianRoot: `0x${string}`;
    readonly guardianThreshold: number;
    readonly configVersion: bigint;
    readonly validators: readonly Address[];
    readonly recoveryConfigured: boolean;
  }>;
  /**
   * An independent endpoint's view of the same account state.
   *
   * The badge this produces sits in front of a signing decision, so one RPC's
   * word is not enough to call a request verified. When the two disagree — or
   * when the second cannot be reached — the request stays an unverified lead.
   * Omitting this keeps single-endpoint deployments working, which is why it is
   * an improvement rather than a new requirement.
   */
  readonly corroborate?: (account: Address) => Promise<LiveGuardianAccountState>;
  readonly previous?: Readonly<Record<string, RecoveryDiscoverySnapshot>>;
  readonly now: number;
}

export async function discoverGuardianRecoveryRequests(input: GuardianDiscoveryInput): Promise<GuardianDiscoveryResult> {
  if (!input.board || !input.recoveryManager) {
    return frozen({
      requests: [],
      rolledBack: [],
      snapshots: {},
      unavailable: "This deployment publishes no on-chain recovery discovery. Ask the person recovering the account to send you their request directly."
    });
  }
  if (!input.logTransport) {
    return frozen({
      requests: [],
      rolledBack: [],
      snapshots: {},
      unavailable: "Recovery discovery needs an RPC that serves event logs. Paste a request or bearer link instead."
    });
  }

  const scoped = input.capabilities.filter(capability => capability.chainId === input.chainId);
  const requests: DiscoveredRequestView[] = [];
  const rolledBack: string[] = [];
  const snapshots: Record<string, RecoveryDiscoverySnapshot> = {};
  let unavailable: string | undefined;

  for (const capability of scoped) {
    try {
      const reader = createRecoveryIntentBoardReader({
        chainId: input.chainId,
        account: capability.account,
        board: input.board,
        recoveryManager: input.recoveryManager,
        logTransport: input.logTransport
      });
      const snapshot = await reader.discover();
      const key = `${capability.chainId}:${capability.account.toLowerCase()}`;
      snapshots[key] = snapshot;

      const earlier = input.previous?.[key];
      if (earlier) {
        const reconciled = reconcileRecoveryDiscovery(earlier, snapshot);
        // A vanished approval is not the same as one that never existed, so the
        // caller is told rather than shown a quietly smaller number.
        if (reconciled.rolledBack) rolledBack.push(...reconciled.droppedApprovals);
      }

      // Live state is read per account and never taken from the logs.
      const live = await input.inspect(capability.account);
      const confirmed = await corroborated(input.corroborate, capability.account, live);
      requests.push(...classifyDiscoveredRequests({
        ...(confirmed ? {} : { contested: true }),
        announcements: snapshot.announcements,
        approvals: snapshot.approvals,
        capability,
        live,
        recoveryManager: input.recoveryManager,
        board: input.board,
        now: input.now
      }));
    } catch {
      // One unreachable account must not hide requests for the others, and the
      // reason is not surfaced: it would describe another party's account state.
      unavailable = "Some protected accounts could not be checked. Paste a request or bearer link if you were expecting one.";
    }
  }

  return frozen({
    requests: sortRequests(requests),
    rolledBack: Object.freeze([...new Set(rolledBack)]),
    snapshots: Object.freeze(snapshots),
    ...(unavailable === undefined ? {} : { unavailable })
  });
}

/** Verified requests first, then the ones closest to expiry. */
function sortRequests(requests: readonly DiscoveredRequestView[]): readonly DiscoveredRequestView[] {
  return Object.freeze([...requests].sort((left, right) => {
    if (left.trust !== right.trust) return left.trust === "verified" ? -1 : 1;
    return (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER);
  }));
}

function frozen(result: GuardianDiscoveryResult): GuardianDiscoveryResult {
  return Object.freeze(result);
}

/**
 * Whether a second endpoint confirms the fields a verified badge depends on.
 *
 * An unreachable second endpoint counts as unconfirmed rather than as agreement:
 * failing open here would make the corroboration disappear exactly when an
 * endpoint is misbehaving, which is when it matters.
 */
async function corroborated(
  read: ((account: Address) => Promise<LiveGuardianAccountState>) | undefined,
  account: Address,
  live: LiveGuardianAccountState
): Promise<boolean> {
  if (!read) return true;
  try {
    const other = await read(account);
    return other.guardianRoot.toLowerCase() === live.guardianRoot.toLowerCase()
      && other.configVersion === live.configVersion
      && other.guardianThreshold === live.guardianThreshold
      && other.recoveryConfigured === live.recoveryConfigured
      && other.validators.length === live.validators.length
      && other.validators.every((item, index) => item.toLowerCase() === live.validators[index]!.toLowerCase());
  } catch {
    return false;
  }
}
