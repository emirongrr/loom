import assert from "node:assert/strict";
import test from "node:test";

import { readScheduledOperations } from "../src/features/security/scheduledOperations.ts";

const ACCOUNT = "0x73E1Fc60aB8b5F31a36a640d1f8035E99cE8192C";
const TOPIC = "0x23f591c4e1e1df4b32c3f5098b21b1d3a260ae413cc5949f6474dfe17194155c";
const OP_A = `0x${"a1".repeat(32)}`;
const OP_B = `0x${"b2".repeat(32)}`;
const TX_A = `0x${"31".repeat(32)}`;

const CONFIG = {
  rpcUrl: "https://rpc.example",
  bundlerUrl: "https://bundler.example",
  explorerUrl: "https://explorer.example",
  relayUrl: ""
} as const;

const READY_AT = 1_785_154_236n;
const BLOCK_TIME = 1_785_100_000n;

test("a scheduled operation is discovered and its ready time comes from the account", async () => {
  const result = await withFetch(
    chain({ logs: [{ topics: [TOPIC, OP_A], transactionHash: TX_A }], scheduled: { [OP_A]: READY_AT }, blockTimestamp: BLOCK_TIME }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, false);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.operationId, OP_A);
  assert.equal(result.operations[0]?.readyAt, READY_AT);
  assert.equal(result.operations[0]?.ready, false, "the delay has not elapsed at this block");
  assert.equal(result.operations[0]?.transactionHash, TX_A, "the hash comes from the matching chain log");
  assert.equal(result.operations[0]?.blockNumber, 1n);
  assert.equal(result.chainBlockNumber, 1n);
});

test("a stale log for the same operation cannot supply the transaction hash", async () => {
  const staleHash = `0x${"41".repeat(32)}`;
  const currentHash = `0x${"42".repeat(32)}`;
  const result = await withFetch(
    chain({
      logs: [
        { topics: [TOPIC, OP_A], readyAt: READY_AT - 100n, transactionHash: staleHash, blockNumber: 1n },
        { topics: [TOPIC, OP_A], readyAt: READY_AT, transactionHash: currentHash, blockNumber: 2n }
      ],
      scheduled: { [OP_A]: READY_AT },
      blockTimestamp: BLOCK_TIME,
      blockNumber: 2n
    }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.transactionHash, currentHash);
  assert.equal(result.operations[0]?.blockNumber, 2n);
});

test("an RPC-verified receipt supplies provenance when historical log scans are unavailable", async () => {
  const result = await withFetch(
    chain({
      logs: [{ topics: [TOPIC, OP_A], transactionHash: TX_A }],
      scheduled: { [OP_A]: READY_AT },
      blockTimestamp: BLOCK_TIME,
      rpcLogsUnavailable: true
    }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, false);
  assert.equal(result.operations[0]?.transactionHash, TX_A);
  assert.equal(result.operations[0]?.readyAt, READY_AT);
});

test("an explorer candidate cannot substitute a receipt from another account", async () => {
  const result = await withFetch(
    chain({
      logs: [{
        topics: [TOPIC, OP_A],
        transactionHash: TX_A,
        receiptAddress: "0x0000000000000000000000000000000000000002"
      }],
      scheduled: { [OP_A]: READY_AT },
      blockTimestamp: BLOCK_TIME,
      rpcLogsUnavailable: true
    }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, false);
  assert.equal(result.operations.length, 0);
});

test("an operation whose delay has elapsed reads as ready", async () => {
  const result = await withFetch(
    chain({ logs: [{ topics: [TOPIC, OP_A] }], scheduled: { [OP_A]: READY_AT }, blockTimestamp: READY_AT + 1n }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );
  assert.equal(result.operations[0]?.ready, true);
});

// The account is the authority: an id the indexer still lists but the account no
// longer holds has been executed or cancelled, and must not be shown as pending.
test("an executed or cancelled operation is dropped even though its log remains", async () => {
  const result = await withFetch(
    chain({ logs: [{ topics: [TOPIC, OP_A] }, { topics: [TOPIC, OP_B] }], scheduled: { [OP_A]: 0n, [OP_B]: READY_AT }, blockTimestamp: BLOCK_TIME }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.operationId, OP_B);
});

// A hostile indexer can offer ids, but the account decides whether they exist.
test("an operation a fabricated log invents is refused by the account", async () => {
  const invented = `0x${"ee".repeat(32)}`;
  const result = await withFetch(
    chain({ logs: [{ topics: [TOPIC, invented] }], scheduled: {}, blockTimestamp: BLOCK_TIME }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );
  assert.equal(result.operations.length, 0);
});

test("unrelated events and malformed topics are ignored", async () => {
  const result = await withFetch(
    chain({
      logs: [
        { topics: [`0x${"cc".repeat(32)}`, OP_A] },
        { topics: [TOPIC] },
        { topics: [TOPIC, "0xnot-a-hash"] },
        { topics: [TOPIC, OP_B] }
      ],
      scheduled: { [OP_A]: READY_AT, [OP_B]: READY_AT }, blockTimestamp: BLOCK_TIME
    }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.operations.length, 1, "only the well-formed OperationScheduled log counts");
  assert.equal(result.operations[0]?.operationId, OP_B);
});

test("the same operation logged twice is reported once", async () => {
  const result = await withFetch(
    chain({ logs: [{ topics: [TOPIC, OP_A] }, { topics: [TOPIC, OP_A] }], scheduled: { [OP_A]: READY_AT }, blockTimestamp: BLOCK_TIME }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );
  assert.equal(result.operations.length, 1);
});

// "No operations found" and "discovery failed" are different statements.
test("an RPC that cannot return account logs reports discovery as unavailable", async () => {
  const result = await withFetch(
    chain({ logs: [], scheduled: {}, blockTimestamp: BLOCK_TIME, rpcLogsUnavailable: true, explorerLogsStatus: 429 }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, true);
  assert.equal(result.operations.length, 0);
});

function chain(input: {
  logs: { topics: string[]; readyAt?: bigint; transactionHash?: string; blockNumber?: bigint; logIndex?: bigint; receiptAddress?: string }[];
  scheduled: Record<string, bigint>;
  blockTimestamp: bigint;
  blockNumber?: bigint;
  rpcLogsUnavailable?: boolean;
  explorerLogsStatus?: number;
}): typeof fetch {
  return async (target, init) => {
    if (String(target).startsWith(CONFIG.explorerUrl)) {
      if (input.explorerLogsStatus && input.explorerLogsStatus !== 200) {
        return new Response("rate limited", { status: input.explorerLogsStatus });
      }
      return Response.json({ items: input.logs.map(log => ({ topics: log.topics, transaction_hash: log.transactionHash })) });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_getBlockByNumber") {
      const blockNumber = input.blockNumber ?? 1n;
      return respond({ number: `0x${blockNumber.toString(16)}`, timestamp: `0x${input.blockTimestamp.toString(16)}`, hash: `0x${"11".repeat(32)}` });
    }
    if (body.method === "eth_getLogs") {
      if (input.rpcLogsUnavailable) {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "log range unavailable" } });
      }
      return respond(input.logs.map((log, index) => {
        const operationId = log.topics[1] ?? "";
        const readyAt = log.readyAt ?? input.scheduled[operationId] ?? 0n;
        const blockNumber = log.blockNumber ?? 1n;
        return {
          address: log.receiptAddress ?? ACCOUNT,
          topics: log.topics,
          data: `0x${readyAt.toString(16).padStart(64, "0")}`,
          blockNumber: `0x${blockNumber.toString(16)}`,
          transactionHash: log.transactionHash ?? `0x${String(index + 1).padStart(64, "0")}`,
          transactionIndex: "0x0",
          blockHash: `0x${"11".repeat(32)}`,
          logIndex: `0x${(log.logIndex ?? BigInt(index)).toString(16)}`,
          removed: false
        };
      }));
    }
    if (body.method === "eth_getTransactionReceipt") {
      const hash = String(body.params?.[0] ?? "");
      const matching = input.logs.filter(log => (log.transactionHash ?? "").toLowerCase() === hash.toLowerCase());
      if (matching.length === 0) return respond(null);
      const blockNumber = matching[0]?.blockNumber ?? 1n;
      return respond({
        blockHash: `0x${"11".repeat(32)}`,
        blockNumber: `0x${blockNumber.toString(16)}`,
        contractAddress: null,
        cumulativeGasUsed: "0x1",
        effectiveGasPrice: "0x1",
        from: "0x0000000000000000000000000000000000000001",
        gasUsed: "0x1",
        logs: matching.map((log, index) => ({
          address: log.receiptAddress ?? ACCOUNT,
          topics: log.topics,
          data: `0x${(log.readyAt ?? input.scheduled[log.topics[1] ?? ""] ?? 0n).toString(16).padStart(64, "0")}`,
          blockNumber: `0x${(log.blockNumber ?? 1n).toString(16)}`,
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: `0x${"11".repeat(32)}`,
          logIndex: `0x${(log.logIndex ?? BigInt(index)).toString(16)}`,
          removed: false
        })),
        logsBloom: `0x${"00".repeat(256)}`,
        status: "0x1",
        to: ACCOUNT,
        transactionHash: hash,
        transactionIndex: "0x0",
        type: "0x2"
      });
    }
    if (body.method === "eth_call") {
      // scheduledOperations(bytes32): the id is the single argument word.
      const data = String(body.params?.[0]?.data ?? "");
      const operationId = `0x${data.slice(10, 74)}`;
      const readyAt = input.scheduled[operationId] ?? 0n;
      return respond(`0x${readyAt.toString(16).padStart(64, "0")}`);
    }
    return respond("0x");
  };
}

async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}
