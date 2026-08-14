import type { Address, Hex } from "@loom/core";
import type { RecoveryLogEntry, RecoveryLogTransport } from "@loom/sdk/recovery";
import type { NetworkConfig } from "../config/network";
import type { PublicClientRegistry } from "../services/rpc/publicClients";

/**
 * A replaceable `eth_getLogs` adapter for recovery discovery.
 *
 * Log reads are deliberately separate from the state transport used for
 * authoritative `eth_call` reads: an integrator may point discovery at a
 * different, cheaper, or more permissive endpoint without changing where
 * security-critical state comes from. Nothing this returns is trusted — the SDK
 * re-checks every log's address, account, and manager, and the recovery client
 * re-verifies every approval before it is submitted.
 *
 * If this endpoint is unavailable or refuses the range, discovery fails and the
 * QR, file, clipboard, and direct paths continue to work unchanged.
 */
export function createRecoveryLogTransport(
  config: NetworkConfig,
  publicClients: PublicClientRegistry
): RecoveryLogTransport {
  const client = publicClients.forEndpoint(config.rpcUrl);
  return Object.freeze({
    async getBlockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },
    async getLogs(input: {
      readonly address: Address;
      readonly topics: readonly (Hex | readonly Hex[] | null)[];
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
    }): Promise<readonly RecoveryLogEntry[]> {
      const logs = await client.request({
        method: "eth_getLogs",
        params: [{
          address: input.address,
          topics: input.topics as never,
          fromBlock: hex(input.fromBlock),
          toBlock: hex(input.toBlock)
        }]
      } as never) as readonly RawLog[];
      // Normalize the wire shape only. Anything that cannot be read as a log is
      // dropped here rather than passed on as a half-decoded entry.
      return Object.freeze(logs.flatMap(log => {
        if (!log || typeof log !== "object" || typeof log.data !== "string" || !Array.isArray(log.topics)) return [];
        // A pending log carries null block fields. Discovery is about settled
        // history, so those are dropped rather than shown as zero-block entries.
        if (typeof log.blockNumber !== "string" || typeof log.logIndex !== "string" || typeof log.blockHash !== "string") return [];
        return [Object.freeze({
          address: log.address as Address,
          topics: Object.freeze(log.topics as Hex[]),
          data: log.data as Hex,
          blockNumber: BigInt(log.blockNumber),
          blockHash: log.blockHash as Hex,
          logIndex: Number(BigInt(log.logIndex)),
          transactionHash: (log.transactionHash ?? `0x${"00".repeat(32)}`) as Hex,
          removed: log.removed === true
        })];
      }));
    }
  });
}

interface RawLog {
  readonly address?: string;
  readonly topics?: unknown;
  readonly data?: unknown;
  readonly blockNumber?: string | null;
  readonly blockHash?: string | null;
  readonly logIndex?: string | null;
  readonly transactionHash?: string | null;
  readonly removed?: boolean;
}

function hex(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}
