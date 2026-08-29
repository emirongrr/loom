import type { Address, Hex } from "@loom/core";
import { RecoveryIntentBoardAbi } from "@loom/core/abi";
import { decodeEventLog, encodeEventTopics, getAddress, isAddress } from "viem";
import { GuardianRecoveryError, type GuardianApprovalTuple } from "./recovery.js";

/**
 * Reads `RecoveryIntentBoard` logs so a guardian can discover an active recovery
 * for an account they already hold a capability for, and so any party can
 * reassemble a threshold bundle that no single device ever held.
 *
 * Three properties govern this module, all of them recorded in
 * `docs/decisions/0024-recovery-intent-board.md`:
 *
 * 1. **Nothing here verifies anything.** Every result carries
 *    `status: "unverified"` in its *type*, not merely in a comment, so a caller
 *    cannot accidentally treat a log as evidence. Authoritative verification
 *    stays in `createGuardianRecoveryClient(...).proposeRecovery`, which
 *    re-derives each leaf, re-checks the Merkle proof against the live guardian
 *    root, and re-runs each verifier signature before submitting.
 * 2. **Queries are bounded.** Public RPCs cap `eth_getLogs` ranges and result
 *    counts, and discovery must never require an indexer. Ranges are split into
 *    explicit windows and both the window count and the total log count fail
 *    closed rather than degrading into an unbounded scan.
 * 3. **Logs can disappear.** A count derived from logs is reorg-sensitive in a
 *    way an `eth_call` read is not. `reconcileRecoveryDiscovery` exists so a
 *    rollback is an explicit, reportable event instead of a silently shrinking
 *    number.
 *
 * A transport is free to be hostile or merely wrong: every log is re-checked
 * against the requested board address, account, and recovery manager before it
 * is decoded into anything a caller sees.
 */

/** One `eth_getLogs` entry, in the shape every mainstream client already returns. */
export interface RecoveryLogEntry {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logIndex: number;
  readonly transactionHash: Hex;
  readonly removed?: boolean;
}

/**
 * The narrow log-reading capability discovery needs. Deliberately not
 * `LoomStateReadTransport`: that interface is for `eth_call`, and an integrator
 * may reasonably point log queries at a different, cheaper, or more permissive
 * endpoint than the one used for authoritative state.
 */
export interface RecoveryLogTransport {
  getBlockNumber(): Promise<bigint>;
  getLogs(input: {
    readonly address: Address;
    /** Positional topic filter; an array at a position means "any of these". */
    readonly topics: readonly (Hex | readonly Hex[] | null)[];
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly RecoveryLogEntry[]>;
}

interface DiscoveredBase {
  /** Always `"unverified"`. A log is a hint; `proposeRecovery` is the authority. */
  readonly status: "unverified";
  readonly recoveryId: Hex;
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logIndex: number;
  /** True once the entry is at least `confirmations` blocks deep. */
  readonly confirmed: boolean;
}

export interface DiscoveredRecoveryApproval extends DiscoveredBase {
  readonly guardianLeaf: Hex;
  /** Exactly the tuple `RecoveryManager.proposeRecovery` expects, unverified. */
  readonly approval: GuardianApprovalTuple;
}

/**
 * One guardian's published signature to *stop* a pending recovery.
 *
 * Structurally identical to an approval and kept rigorously apart from one.
 * They are signatures over different EIP-712 types answering opposite
 * questions, so a consumer that merged the two arrays would be assembling a
 * bundle the manager refuses -- after the gas, and after telling someone their
 * quorum was reached.
 */
export interface DiscoveredRecoveryCancellation extends DiscoveredBase {
  readonly guardianLeaf: Hex;
  /** The tuple `cancelRecoveryWith...` expects, unverified. */
  readonly approval: GuardianApprovalTuple;
}

export interface DiscoveredRecoveryAnnouncement extends DiscoveredBase {
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly configVersion: bigint;
  readonly nonce: bigint;
  readonly expiresAt: bigint;
}

export interface RecoveryDiscoverySnapshot {
  readonly chainId: number;
  readonly account: Address;
  readonly board: Address;
  readonly recoveryManager: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly latestBlock: bigint;
  readonly announcements: readonly DiscoveredRecoveryAnnouncement[];
  readonly approvals: readonly DiscoveredRecoveryApproval[];
  readonly cancellations: readonly DiscoveredRecoveryCancellation[];
  /** Approvals deep enough to act on. Never treat this as a verified threshold. */
  readonly confirmedApprovalCount: number;
  readonly confirmedCancellationCount: number;
}

export interface RecoveryDiscoveryReconciliation {
  readonly snapshot: RecoveryDiscoverySnapshot;
  readonly rolledBack: boolean;
  /** Guardian leaves that were present before and are not present now. */
  readonly droppedApprovals: readonly Hex[];
  readonly droppedCancellations: readonly Hex[];
}

/** Mirrors `RecoveryIntentBoard.MAX_SIGNATURE_BYTES`. */
const MAX_SIGNATURE_BYTES = 4096;
/** Mirrors `GuardianVerificationLib.MAX_PROOF_LENGTH`. */
const MAX_PROOF_LENGTH = 32;

/** `topic0` for each board event, derived from the generated (contract) ABI. */
const ANNOUNCED_TOPIC = eventTopic("RecoveryAnnounced");
const APPROVAL_TOPIC = eventTopic("RecoveryApprovalPublished");
const CANCELLATION_TOPIC = eventTopic("RecoveryCancellationPublished");

const DEFAULT_MAX_BLOCK_RANGE = 2_000n;
const DEFAULT_MAX_WINDOWS = 32;
const DEFAULT_MAX_LOGS = 512;
const DEFAULT_CONFIRMATIONS = 5n;

export function createRecoveryIntentBoardReader(options: {
  readonly chainId: number;
  readonly account: Address;
  readonly board: Address;
  readonly recoveryManager: Address;
  readonly logTransport?: RecoveryLogTransport;
  /** Blocks per `eth_getLogs` call. Keep at or below the endpoint's own cap. */
  readonly maxBlockRange?: bigint;
  /** Windows per discovery call, so a wide range fails closed instead of scanning. */
  readonly maxWindows?: number;
  /** Total logs accepted per discovery call. */
  readonly maxLogs?: number;
  /** Depth at which an entry is reported as `confirmed`. */
  readonly confirmations?: bigint;
}) {
  const transport = options.logTransport;
  if (!transport?.getLogs || !transport?.getBlockNumber) {
    throw discoveryError(
      "RECOVERY_DISCOVERY_UNAVAILABLE",
      "recovery discovery requires a log transport",
      "Point the wallet at an RPC that serves eth_getLogs, or use the QR, file, or clipboard path."
    );
  }
  const chainId = options.chainId;
  const account = checkAddress(options.account, "account");
  const board = checkAddress(options.board, "intent board");
  const recoveryManager = checkAddress(options.recoveryManager, "recovery manager");
  const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE;
  const maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
  const maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
  const confirmations = options.confirmations ?? DEFAULT_CONFIRMATIONS;
  const accountTopic = addressTopic(account);
  if (maxBlockRange <= 0n || maxWindows < 1 || maxLogs < 1 || confirmations < 0n) {
    throw discoveryError("RECOVERY_DISCOVERY_LIMIT_EXCEEDED", "recovery discovery bounds are invalid");
  }

  return {
    /**
     * Query the board over a bounded range and decode whatever survives the
     * address, account, manager, and size checks.
     *
     * `fromBlock` defaults to the widest window budget below `toBlock`, so the
     * default call is bounded rather than reaching genesis.
     */
    async discover(range: { readonly fromBlock?: bigint; readonly toBlock?: bigint } = {}): Promise<RecoveryDiscoverySnapshot> {
      const latestBlock = await call(() => transport.getBlockNumber(), "latest block");
      const toBlock = range.toBlock ?? latestBlock;
      const budget = maxBlockRange * BigInt(maxWindows);
      const fromBlock = range.fromBlock ?? (toBlock > budget ? toBlock - budget + 1n : 0n);
      if (fromBlock > toBlock) {
        throw discoveryError("RECOVERY_DISCOVERY_LIMIT_EXCEEDED", "recovery discovery range is inverted");
      }

      const span = toBlock - fromBlock + 1n;
      const windows = span / maxBlockRange + (span % maxBlockRange === 0n ? 0n : 1n);
      if (windows > BigInt(maxWindows)) {
        throw discoveryError(
          "RECOVERY_DISCOVERY_LIMIT_EXCEEDED",
          `recovery discovery needs ${windows} windows but only ${maxWindows} are allowed`,
          "Narrow the block range, or raise maxBlockRange if the endpoint permits it."
        );
      }

      const raw: RecoveryLogEntry[] = [];
      for (let start = fromBlock; start <= toBlock; start += maxBlockRange) {
        const end = start + maxBlockRange - 1n > toBlock ? toBlock : start + maxBlockRange - 1n;
        // Filter server-side by event and by the indexed account. Without this
        // the cap below is spent on other accounts' publications, which would
        // let a busy board starve a legitimate guardian's discovery. It narrows
        // the endpoint's work, not the trust: every returned log is still
        // re-checked locally, because a transport may ignore the filter.
        const page = await call(
          () => transport.getLogs({
            address: board,
            topics: [[ANNOUNCED_TOPIC, APPROVAL_TOPIC, CANCELLATION_TOPIC], accountTopic],
            fromBlock: start,
            toBlock: end
          }),
          `logs for blocks ${start}-${end}`
        );
        raw.push(...page);
        if (raw.length > maxLogs) {
          throw discoveryError(
            "RECOVERY_DISCOVERY_LIMIT_EXCEEDED",
            `recovery discovery returned more than ${maxLogs} logs`,
            "Narrow the block range; a wider scan needs its own paging strategy."
          );
        }
      }

      const confirmedBelow = latestBlock >= confirmations ? latestBlock - confirmations : 0n;
      const announcements: DiscoveredRecoveryAnnouncement[] = [];
      const approvals = new Map<string, DiscoveredRecoveryApproval>();
      const cancellations = new Map<string, DiscoveredRecoveryCancellation>();

      for (const log of raw) {
        // A transport may return anything. Re-check the address before decoding,
        // so a log from an unrelated contract can never be shaped into a result.
        if (log.removed === true) continue;
        if (!sameAddress(log.address, board)) continue;
        const decoded = decode(log);
        if (!decoded) continue;
        if (!sameAddress(decoded.args.account as Address, account)) continue;
        if (!sameAddress(decoded.args.recoveryManager as Address, recoveryManager)) continue;

        const base = {
          status: "unverified" as const,
          recoveryId: lower(decoded.args.recoveryId as Hex),
          account,
          recoveryManager,
          blockNumber: log.blockNumber,
          blockHash: lower(log.blockHash),
          logIndex: log.logIndex,
          confirmed: log.blockNumber <= confirmedBelow
        };

        if (decoded.eventName === "RecoveryAnnounced") {
          announcements.push(Object.freeze({
            ...base,
            oldValidatorsHash: lower(decoded.args.oldValidatorsHash as Hex),
            newValidator: getAddress(decoded.args.newValidator as string) as Address,
            initDataHash: lower(decoded.args.initDataHash as Hex),
            newGuardianRoot: lower(decoded.args.newGuardianRoot as Hex),
            newGuardianThreshold: Number(decoded.args.newGuardianThreshold),
            configVersion: BigInt(decoded.args.configVersion as bigint),
            nonce: BigInt(decoded.args.nonce as bigint),
            expiresAt: BigInt(decoded.args.expiresAt as bigint)
          }));
          continue;
        }

        const signature = lower(decoded.args.signature as Hex);
        const proof = (decoded.args.proof as readonly Hex[]).map(lower);
        // The contract already enforces both bounds. Re-check them so a log from
        // a different or future board cannot hand an oversized payload onward.
        if ((signature.length - 2) / 2 > MAX_SIGNATURE_BYTES) continue;
        if (proof.length > MAX_PROOF_LENGTH) continue;

        const guardianLeaf = lower(decoded.args.guardianLeaf as Hex);
        const entry: DiscoveredRecoveryApproval = Object.freeze({
          ...base,
          guardianLeaf,
          approval: Object.freeze({
            verifier: getAddress(decoded.args.verifier as string) as Address,
            keyCommitment: lower(decoded.args.keyCommitment as Hex),
            salt: lower(decoded.args.salt as Hex),
            signature,
            proof: Object.freeze(proof),
            leaf: guardianLeaf
          })
        });

        // One guardian leaf approves a given recovery once. A republication is
        // redundant, and `GuardianVerificationLib` rejects duplicates anyway, so
        // keep the earliest and let the later copy fall away here.
        const key = `${base.recoveryId}:${guardianLeaf}`;
        if (decoded.eventName === "RecoveryCancellationPublished") {
          const existingCancellation = cancellations.get(key);
          if (!existingCancellation || earlier(entry, existingCancellation)) cancellations.set(key, entry);
          continue;
        }
        const existing = approvals.get(key);
        if (!existing || earlier(entry, existing)) approvals.set(key, entry);
      }

      const ordered = [...approvals.values()].sort((left, right) => (earlier(left, right) ? -1 : 1));
      const orderedCancellations = [...cancellations.values()].sort((left, right) => (earlier(left, right) ? -1 : 1));
      return Object.freeze({
        chainId,
        account,
        board,
        recoveryManager,
        fromBlock,
        toBlock,
        latestBlock,
        announcements: Object.freeze(announcements.sort((left, right) => (earlier(left, right) ? -1 : 1))),
        approvals: Object.freeze(ordered),
        cancellations: Object.freeze(orderedCancellations),
        confirmedApprovalCount: ordered.filter(entry => entry.confirmed).length,
        confirmedCancellationCount: orderedCancellations.filter(entry => entry.confirmed).length
      });
    }
  };
}

/**
 * Compare a newer snapshot against an older one and report what a reorg removed.
 *
 * Callers must render `rolledBack` rather than quietly replacing a count: an
 * approval that vanished is not the same event as an approval that never
 * existed, and a guardian who saw "2 of 2" must be told when it becomes "1 of 2".
 */
export function reconcileRecoveryDiscovery(
  previous: RecoveryDiscoverySnapshot,
  next: RecoveryDiscoverySnapshot
): RecoveryDiscoveryReconciliation {
  if (
    !sameAddress(previous.account, next.account)
    || !sameAddress(previous.board, next.board)
    || !sameAddress(previous.recoveryManager, next.recoveryManager)
    || previous.chainId !== next.chainId
  ) {
    throw discoveryError(
      "INVALID_RECOVERY_APPROVAL_LOG",
      "recovery discovery snapshots describe different accounts, boards, managers, or chains"
    );
  }

  // A different block hash for the same entry means the one the caller was
  // shown is gone, even though an equivalent one was re-mined.
  const disappeared = (
    before: readonly { readonly recoveryId: Hex; readonly guardianLeaf: Hex; readonly blockHash: Hex }[],
    after: readonly { readonly recoveryId: Hex; readonly guardianLeaf: Hex; readonly blockHash: Hex }[]
  ): Hex[] => {
    const current = new Map(after.map(entry => [`${entry.recoveryId}:${entry.guardianLeaf}`, entry]));
    const gone: Hex[] = [];
    for (const entry of before) {
      const survivor = current.get(`${entry.recoveryId}:${entry.guardianLeaf}`);
      if (!survivor || survivor.blockHash !== entry.blockHash) gone.push(entry.guardianLeaf);
    }
    return gone;
  };

  const dropped = disappeared(previous.approvals, next.approvals);
  // Reported for the same reason approvals are: someone was told a quorum to
  // stop a recovery had been reached, and it has not.
  const droppedCancellations = disappeared(previous.cancellations, next.cancellations);

  return Object.freeze({
    snapshot: next,
    rolledBack: dropped.length > 0 || droppedCancellations.length > 0,
    droppedApprovals: Object.freeze(dropped),
    droppedCancellations: Object.freeze(droppedCancellations)
  });
}

function eventTopic(eventName: "RecoveryAnnounced" | "RecoveryApprovalPublished" | "RecoveryCancellationPublished"): Hex {
  return encodeEventTopics({ abi: RecoveryIntentBoardAbi, eventName })[0] as Hex;
}

/** `abi.encode(address)` — the indexed-topic encoding of an address. */
function addressTopic(value: Address): Hex {
  return `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}` as Hex;
}

function decode(log: RecoveryLogEntry): { eventName: string; args: Record<string, unknown> } | undefined {
  try {
    const result = decodeEventLog({
      abi: RecoveryIntentBoardAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]]
    });
    if (
      result.eventName !== "RecoveryAnnounced"
      && result.eventName !== "RecoveryApprovalPublished"
      && result.eventName !== "RecoveryCancellationPublished"
    ) return undefined;
    return { eventName: result.eventName, args: result.args as unknown as Record<string, unknown> };
  } catch {
    // A malformed, truncated, or foreign log is discarded, never surfaced.
    return undefined;
  }
}

async function call<T>(action: () => Promise<T>, what: string): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw discoveryError(
      "RECOVERY_DISCOVERY_UNAVAILABLE",
      `recovery discovery could not read ${what}`,
      "Recovery still works through the QR, file, clipboard, and direct submission paths.",
      cause
    );
  }
}

function earlier(left: { blockNumber: bigint; logIndex: number }, right: { blockNumber: bigint; logIndex: number }): boolean {
  return left.blockNumber === right.blockNumber ? left.logIndex < right.logIndex : left.blockNumber < right.blockNumber;
}

function sameAddress(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function lower(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

function checkAddress(value: Address, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw discoveryError("INVALID_RECOVERY_APPROVAL_LOG", `${label} must be an address`);
  }
  return getAddress(value) as Address;
}

function discoveryError(
  code: "RECOVERY_DISCOVERY_UNAVAILABLE" | "RECOVERY_DISCOVERY_LIMIT_EXCEEDED" | "INVALID_RECOVERY_APPROVAL_LOG",
  message: string,
  remediation?: string,
  cause?: unknown
): GuardianRecoveryError {
  return new GuardianRecoveryError(code, message, {
    safeMessage: "Recovery requests could not be read from the network.",
    ...(remediation === undefined ? {} : { remediation }),
    ...(cause === undefined ? {} : { cause })
  });
}
