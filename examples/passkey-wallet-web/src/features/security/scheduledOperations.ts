import type { Address, Hex } from "@loom/core";
import { createPublicClient, http, type PublicClient } from "viem";
import type { NetworkConfig } from "../../config/network";

// A scheduled operation is stored under a hash of its contents. Candidate ids
// therefore come from the account's own logs, while current liveness and timing
// come from the account's storage. Both are checked against one fixed block.
//
// Some public RPCs refuse historical log-range scans. In that case the explorer
// may suggest transaction hashes, but every receipt and event is fetched again
// from the RPC. The explorer is discovery-only and cannot fabricate evidence.

const OPERATION_SCHEDULED_TOPIC = "0x23f591c4e1e1df4b32c3f5098b21b1d3a260ae413cc5949f6474dfe17194155c";

const OPERATION_SCHEDULED_EVENT = {
  type: "event", name: "OperationScheduled",
  inputs: [
    { name: "operationId", type: "bytes32", indexed: true },
    { name: "readyAt", type: "uint48", indexed: false }
  ]
} as const;

const SCHEDULED_OPERATIONS_ABI = [{
  type: "function", name: "scheduledOperations", stateMutability: "view",
  inputs: [{ name: "operationId", type: "bytes32" }], outputs: [{ type: "uint48" }]
}] as const;

interface ScheduleEvidence {
  readonly operationId: Hex;
  readonly readyAt: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export interface ScheduledOperation {
  readonly operationId: Hex;
  /** Read from the account, never trusted from the log alone. */
  readonly readyAt: bigint;
  readonly ready: boolean;
  /** Transaction that emitted the matching on-chain schedule event. */
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

export interface ScheduledOperationsResult {
  readonly operations: readonly ScheduledOperation[];
  /** True when discovery could not run; "none found" would be a false claim. */
  readonly discoveryUnavailable: boolean;
  readonly chainTimestamp: bigint;
  readonly chainBlockNumber?: bigint;
}

/**
 * Every operation the account still has scheduled. The event supplies
 * provenance; the account's storage decides whether it still exists and when
 * it is executable. Matching readyAt prevents an old event for a cancelled and
 * re-scheduled operation id from lending the new state its transaction hash.
 */
export async function readScheduledOperations(input: {
  config: NetworkConfig;
  account: Address;
}): Promise<ScheduledOperationsResult> {
  const client = createPublicClient({ transport: http(input.config.rpcUrl) });
  const block = await client.getBlock().catch(() => null);
  if (block?.number === undefined || block.number === null) {
    return { operations: Object.freeze([]), discoveryUnavailable: true, chainTimestamp: 0n };
  }

  const evidence = await readScheduleEvidence(client, input.config, input.account, block.number).catch(() => null);
  if (evidence === null) {
    return { operations: Object.freeze([]), discoveryUnavailable: true, chainTimestamp: block.timestamp, chainBlockNumber: block.number };
  }

  const candidates = new Map<Hex, ScheduleEvidence[]>();
  for (const item of evidence) candidates.set(item.operationId, [...(candidates.get(item.operationId) ?? []), item]);

  const operations: ScheduledOperation[] = [];
  for (const [operationId, candidatesForId] of candidates) {
    const readyAt = await client.readContract({
      address: input.account,
      abi: SCHEDULED_OPERATIONS_ABI,
      functionName: "scheduledOperations",
      args: [operationId],
      blockNumber: block.number
    }).catch(() => 0n);
    const value = BigInt(readyAt as bigint | number);
    if (value === 0n) continue;

    const matching = candidatesForId
      .filter(item => item.readyAt === value && item.blockNumber <= block.number)
      .sort((a, b) => {
        const blockOrder = Number(b.blockNumber - a.blockNumber);
        return blockOrder !== 0 ? blockOrder : b.logIndex - a.logIndex;
      })[0];
    if (!matching) continue;

    operations.push(Object.freeze({
      operationId,
      readyAt: value,
      ready: block.timestamp >= value,
      transactionHash: matching.transactionHash,
      blockNumber: matching.blockNumber
    }));
  }

  return {
    operations: Object.freeze(operations.sort((a, b) => (a.readyAt < b.readyAt ? -1 : a.readyAt > b.readyAt ? 1 : 0))),
    discoveryUnavailable: false,
    chainTimestamp: block.timestamp,
    chainBlockNumber: block.number
  };
}

async function readScheduleEvidence(
  client: PublicClient,
  config: NetworkConfig,
  account: Address,
  toBlock: bigint
): Promise<readonly ScheduleEvidence[]> {
  try {
    const logs = await client.getLogs({ address: account, event: OPERATION_SCHEDULED_EVENT, fromBlock: 0n, toBlock, strict: true });
    return logs.flatMap(log => {
      if (!log.args.operationId || log.args.readyAt === undefined || !log.transactionHash || log.blockNumber === null) return [];
      return [{
        operationId: log.args.operationId,
        readyAt: BigInt(log.args.readyAt),
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex ?? 0
      }];
    });
  } catch {
    return readReceiptEvidence(client, config, account);
  }
}

async function readReceiptEvidence(client: PublicClient, config: NetworkConfig, account: Address): Promise<readonly ScheduleEvidence[]> {
  const hashes = await discoverCandidateTransactionHashes(config, account);
  const evidence: ScheduleEvidence[] = [];
  for (const hash of hashes) {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt || receipt.status !== "success") continue;
    for (const log of receipt.logs) {
      const parsed = parseScheduleLog(account, hash, receipt.blockNumber, log);
      if (parsed) evidence.push(parsed);
    }
  }
  return Object.freeze(evidence);
}

async function discoverCandidateTransactionHashes(config: NetworkConfig, account: Address): Promise<readonly Hex[]> {
  const url = `${config.explorerUrl.replace(/\/$/, "")}/api/v2/addresses/${account}/logs`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`log discovery returned ${response.status}`);
  const body: unknown = await response.json();
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("log discovery returned an invalid response");

  const hashes = new Set<Hex>();
  for (const item of items) {
    const record = item as { topics?: unknown; transaction_hash?: unknown };
    if (!Array.isArray(record.topics) || String(record.topics[0]).toLowerCase() !== OPERATION_SCHEDULED_TOPIC) continue;
    if (typeof record.transaction_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.transaction_hash)) continue;
    hashes.add(record.transaction_hash as Hex);
    if (hashes.size >= 256) break;
  }
  return Object.freeze([...hashes]);
}

function parseScheduleLog(
  account: Address,
  transactionHash: Hex,
  blockNumber: bigint,
  log: { address: Address; data: Hex; topics: readonly Hex[]; logIndex: number | null }
): ScheduleEvidence | null {
  if (log.address.toLowerCase() !== account.toLowerCase()) return null;
  if (log.topics[0]?.toLowerCase() !== OPERATION_SCHEDULED_TOPIC) return null;
  const operationId = log.topics[1];
  if (!operationId || !/^0x[0-9a-fA-F]{64}$/.test(operationId)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  const readyAt = BigInt(log.data);
  if (readyAt > 0xffffffffffffn) return null;
  return Object.freeze({ operationId, readyAt, transactionHash, blockNumber, logIndex: log.logIndex ?? 0 });
}
