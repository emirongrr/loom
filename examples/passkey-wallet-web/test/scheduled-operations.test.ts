import assert from "node:assert/strict";
import test from "node:test";

import { readScheduledOperations } from "../src/features/security/scheduledOperations.ts";

const ACCOUNT = "0x73E1Fc60aB8b5F31a36a640d1f8035E99cE8192C";
const TOPIC = "0x23f591c4e1e1df4b32c3f5098b21b1d3a260ae413cc5949f6474dfe17194155c";
const OP_A = `0x${"a1".repeat(32)}`;
const OP_B = `0x${"b2".repeat(32)}`;

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
    chain({ logs: [{ topics: [TOPIC, OP_A] }], scheduled: { [OP_A]: READY_AT }, blockTimestamp: BLOCK_TIME }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, false);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.operationId, OP_A);
  assert.equal(result.operations[0]?.readyAt, READY_AT);
  assert.equal(result.operations[0]?.ready, false, "the delay has not elapsed at this block");
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
test("an operation the indexer invents is refused by the account", async () => {
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
test("an unreachable indexer reports discovery as unavailable", async () => {
  const result = await withFetch(
    chain({ logs: [], scheduled: {}, blockTimestamp: BLOCK_TIME, logsStatus: 429 }),
    () => readScheduledOperations({ config: CONFIG, account: ACCOUNT })
  );

  assert.equal(result.discoveryUnavailable, true);
  assert.equal(result.operations.length, 0);
});

function chain(input: {
  logs: { topics: string[] }[];
  scheduled: Record<string, bigint>;
  blockTimestamp: bigint;
  logsStatus?: number;
}): typeof fetch {
  return async (target, init) => {
    const url = String(target);
    if (url.includes("/logs")) {
      if (input.logsStatus && input.logsStatus !== 200) return new Response("rate limited", { status: input.logsStatus });
      return Response.json({ items: input.logs });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_getBlockByNumber") {
      return respond({ number: "0x1", timestamp: `0x${input.blockTimestamp.toString(16)}`, hash: `0x${"11".repeat(32)}` });
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
