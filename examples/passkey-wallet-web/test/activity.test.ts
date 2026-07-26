import assert from "node:assert/strict";
import test from "node:test";

import { readAccountActivity } from "../src/features/wallet/activity.ts";

const ACCOUNT = "0xa9CCd3d19eD3136bED10a734ae3aC0e3ACC8c64C";
const OTHER = "0x00000000000000000000000000000000000000b2";
const TOKEN = "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9";
const COLLECTION = "0x2a0f1C1cE263202f629bF41FA7Caa3D5F8FD52C4";

const CONFIG = {
  rpcUrl: "https://rpc.example",
  bundlerUrl: "https://bundler.example",
  explorerUrl: "https://explorer.example",
  relayUrl: ""
} as const;

const hash = (suffix: string) => `0x${suffix.repeat(64).slice(0, 64)}`;

test("an outgoing native transfer is labelled, signed, and dated", async () => {
  const activity = await withFetch(indexer({
    transactions: [{
      hash: hash("a"), timestamp: "2026-07-26T03:46:48.000000Z", status: "ok", result: "success",
      value: "250000000000000000", from: { hash: ACCOUNT }, to: { hash: OTHER },
      block_number: 11_352_131, confirmations: 500
    }],
    transfers: []
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.unavailable, false);
  assert.equal(activity.items.length, 1);
  const [item] = activity.items;
  assert.equal(item?.kind, "native");
  assert.equal(item?.direction, "sent");
  assert.equal(item?.title, "Sent ETH");
  assert.equal(item?.amount, "0.25 ETH");
  assert.equal(item?.status, "finalized");
  assert.equal(item?.detail, `To ${OTHER.slice(0, 6)}…${OTHER.slice(-4)}`);
  assert.equal(item?.timestamp, Date.parse("2026-07-26T03:46:48.000000Z"));
});

test("an incoming transfer is detected from the account side, not the payload order", async () => {
  const activity = await withFetch(indexer({
    transactions: [{
      hash: hash("b"), timestamp: "2026-07-26T03:00:00.000000Z", status: "ok", result: "success",
      value: "1000000000000000000", from: { hash: OTHER }, to: { hash: ACCOUNT },
      block_number: 10, confirmations: 2
    }],
    transfers: []
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.items[0]?.direction, "received");
  assert.equal(activity.items[0]?.title, "Received ETH");
  assert.equal(activity.items[0]?.status, "included", "a shallow inclusion must not claim finality");
});

test("a reverted transaction is reported as failed, never as a transfer", async () => {
  const activity = await withFetch(indexer({
    transactions: [{
      hash: hash("c"), timestamp: "2026-07-26T03:00:00.000000Z", status: "error", result: "Reverted",
      value: "500000000000000000", from: { hash: ACCOUNT }, to: { hash: OTHER },
      block_number: 11, confirmations: 900
    }],
    transfers: []
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.items[0]?.status, "failed");
});

test("a transaction still in the pool is pending", async () => {
  const activity = await withFetch(indexer({
    transactions: [{
      hash: hash("d"), timestamp: "2026-07-26T03:00:00.000000Z", status: "ok", result: "success",
      value: "1", from: { hash: ACCOUNT }, to: { hash: OTHER }, block_number: null
    }],
    transfers: []
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.items[0]?.status, "pending");
});

test("token transfer detail replaces the bare transaction for the same hash", async () => {
  const shared = hash("e");
  const activity = await withFetch(indexer({
    transactions: [{
      hash: shared, timestamp: "2026-07-26T03:46:48.000000Z", status: "ok", result: "success",
      value: "0", from: { hash: ACCOUNT }, to: { hash: TOKEN }, method: "transfer",
      block_number: 12, confirmations: 100
    }],
    transfers: [{
      transaction_hash: shared, timestamp: "2026-07-26T03:46:48.000000Z",
      from: { hash: ACCOUNT }, to: { hash: OTHER }, token_type: "ERC-20",
      token: { address_hash: TOKEN, symbol: "PYUSD", decimals: "6", type: "ERC-20" },
      total: { decimals: "6", value: "75000000" }, block_number: 12, confirmations: 100
    }]
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.items.length, 1, "one transaction must not appear twice");
  const [item] = activity.items;
  assert.equal(item?.kind, "token");
  assert.equal(item?.title, "Sent PYUSD");
  assert.equal(item?.amount, "75 PYUSD");
  assert.equal(item?.direction, "sent");
});

test("a collectible transfer is labelled with its token id", async () => {
  const activity = await withFetch(indexer({
    transactions: [],
    transfers: [{
      transaction_hash: hash("f"), timestamp: "2026-07-26T03:00:00.000000Z",
      from: { hash: OTHER }, to: { hash: ACCOUNT }, token_type: "ERC-721",
      token: { address_hash: COLLECTION, symbol: "LOOM", type: "ERC-721" },
      total: { token_id: "7", value: "1" }, block_number: 13, confirmations: 999
    }]
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  const [item] = activity.items;
  assert.equal(item?.kind, "nft");
  assert.equal(item?.title, "Received collectible");
  assert.equal(item?.amount, "LOOM #7");
});

test("history is ordered newest first and bounded by the requested limit", async () => {
  const transactions = Array.from({ length: 5 }, (_, index) => ({
    hash: hash(String(index)), timestamp: `2026-07-2${index + 1}T00:00:00.000000Z`,
    status: "ok", result: "success", value: "1",
    from: { hash: ACCOUNT }, to: { hash: OTHER }, block_number: index + 1, confirmations: 5
  }));
  const activity = await withFetch(indexer({ transactions, transfers: [] }), () => readAccountActivity(CONFIG, ACCOUNT, { limit: 3 }));

  assert.equal(activity.items.length, 3);
  const stamps = activity.items.map(item => item.timestamp);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a));
  assert.equal(activity.items[0]?.timestamp, Date.parse("2026-07-25T00:00:00.000000Z"));
});

test("malformed rows are skipped instead of breaking the history", async () => {
  const activity = await withFetch(indexer({
    transactions: [
      { hash: "not-a-hash", timestamp: "2026-07-26T03:00:00.000000Z", value: "1" },
      { hash: hash("9"), timestamp: "nonsense", value: "1" },
      { hash: hash("8"), timestamp: "2026-07-26T03:00:00.000000Z", status: "ok", result: "success", value: "1", from: { hash: ACCOUNT }, to: { hash: OTHER }, block_number: 1, confirmations: 1 }
    ],
    transfers: []
  }), () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.items.length, 1);
  assert.equal(activity.items[0]?.id, hash("8"));
});

// An unreachable indexer means history is unknown; presenting an empty list as
// "no transactions" would be a false statement about the account.
test("an unreachable indexer reports unavailable rather than an empty history", async () => {
  const fetchMock: typeof fetch = async () => new Response("rate limited", { status: 429 });
  const activity = await withFetch(fetchMock, () => readAccountActivity(CONFIG, ACCOUNT));

  assert.equal(activity.unavailable, true);
  assert.equal(activity.items.length, 0);
});

function indexer(data: { transactions: unknown[]; transfers: unknown[] }): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.includes("/token-transfers")) return Response.json({ items: data.transfers });
    if (url.includes("/transactions")) return Response.json({ items: data.transactions });
    return new Response("not found", { status: 404 });
  };
}

async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}
