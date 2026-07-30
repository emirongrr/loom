import type { Address, Hex } from "@loom/core";
import { createPublicClient, http } from "viem";
import type { NetworkConfig } from "../../config/network";

// Discovering that *something* is scheduled needs the account's logs, because a
// scheduled operation is stored under a hash of its contents: without the
// candidate contents there is no id to look up. The explorer index supplies the
// candidate ids; the account itself then supplies the truth.
//
// That split matters. A hostile or broken indexer can only cause an id to be
// offered or withheld — every id it returns is confirmed against the account
// before anything is shown, so it cannot fabricate a pending change, alter when
// one becomes ready, or hide one whose id is already known locally.

const OPERATION_SCHEDULED_TOPIC = "0x23f591c4e1e1df4b32c3f5098b21b1d3a260ae413cc5949f6474dfe17194155c";

const SCHEDULED_OPERATIONS_ABI = [{
  type: "function", name: "scheduledOperations", stateMutability: "view",
  inputs: [{ name: "operationId", type: "bytes32" }], outputs: [{ type: "uint48" }]
}] as const;

export interface ScheduledOperation {
  readonly operationId: Hex;
  /** Read from the account, never from the log. */
  readonly readyAt: bigint;
  readonly ready: boolean;
}

export interface ScheduledOperationsResult {
  readonly operations: readonly ScheduledOperation[];
  /** True when discovery could not run; "none found" would be a false claim. */
  readonly discoveryUnavailable: boolean;
  readonly chainTimestamp: bigint;
}

/**
 * Every operation the account still has scheduled. Ids are discovered from
 * `OperationScheduled` logs and then re-read from the account, so operations
 * that were already executed or cancelled fall away on their own — the account
 * reports a ready time of zero for them.
 */
export async function readScheduledOperations(input: {
  config: NetworkConfig;
  account: Address;
}): Promise<ScheduledOperationsResult> {
  const client = createPublicClient({ transport: http(input.config.rpcUrl) });
  const chainTimestamp = await client.getBlock().then(block => block.timestamp).catch(() => 0n);

  let candidates: readonly Hex[];
  try {
    candidates = await discoverOperationIds(input.config, input.account);
  } catch {
    return { operations: Object.freeze([]), discoveryUnavailable: true, chainTimestamp };
  }

  const operations: ScheduledOperation[] = [];
  for (const operationId of candidates) {
    const readyAt = await client.readContract({
      address: input.account,
      abi: SCHEDULED_OPERATIONS_ABI,
      functionName: "scheduledOperations",
      args: [operationId]
    }).catch(() => 0n);
    const value = BigInt(readyAt as bigint | number);
    if (value === 0n) continue;
    operations.push(Object.freeze({ operationId, readyAt: value, ready: chainTimestamp > 0n && chainTimestamp >= value }));
  }

  return {
    operations: Object.freeze(operations.sort((a, b) => (a.readyAt < b.readyAt ? -1 : a.readyAt > b.readyAt ? 1 : 0))),
    discoveryUnavailable: false,
    chainTimestamp
  };
}

async function discoverOperationIds(config: NetworkConfig, account: Address): Promise<readonly Hex[]> {
  const url = `${config.explorerUrl.replace(/\/$/, "")}/api/v2/addresses/${account}/logs`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`log lookup returned ${response.status}`);
  const body: unknown = await response.json();
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const ids = new Set<Hex>();
  for (const item of items) {
    const topics = (item as { topics?: unknown }).topics;
    if (!Array.isArray(topics) || topics.length < 2) continue;
    if (String(topics[0]).toLowerCase() !== OPERATION_SCHEDULED_TOPIC) continue;
    const operationId = topics[1];
    if (typeof operationId === "string" && /^0x[0-9a-fA-F]{64}$/.test(operationId)) ids.add(operationId as Hex);
  }
  return Object.freeze([...ids]);
}
