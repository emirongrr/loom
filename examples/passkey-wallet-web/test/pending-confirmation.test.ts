import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "@loom/core";
import { EntryPointAbi } from "@loom/core/abi";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { reconcilePendingOperations, resumePendingConfirmation } from "../src/services/loom/pendingConfirmation.ts";

const HASH = `0x${"11".repeat(32)}` as Hex;
const TX = `0x${"22".repeat(32)}` as Hex;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const ENTRY_POINT = "0x3333333333333333333333333333333333333333";
const operation = { accountId: "11155111:wallet", userOperationHash: HASH, submittedAt: 1 };
const account = { id: operation.accountId, account: ACCOUNT } as never;
const config = { bundlerUrl: "https://bundler.example" } as never;
const event = EntryPointAbi.find(item => item.type === "event" && item.name === "UserOperationEvent")!;
const publicClient = { getTransactionReceipt: async () => ({
  transactionHash: TX,
  status: "success",
  logs: [{
    address: ENTRY_POINT,
    topics: encodeEventTopics({ abi: [event], eventName: "UserOperationEvent", args: { userOpHash: HASH, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, true, 1n, 1n])
  }]
}) } as never;

test("a null receipt remains pending across reload", async () => {
  let completed = false;
  const store = { list: async () => [], save: async () => undefined, complete: async () => { completed = true; } };
  const request = (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
  const result = await resumePendingConfirmation({ config, account, operation, store, request, entryPoint: ENTRY_POINT, publicClient, verificationPublicClient: publicClient });
  assert.equal(result.status, "pending");
  assert.equal(completed, false);
});

test("a confirmed receipt completes only the persisted hash", async () => {
  let completedHash: Hex | undefined;
  const store = { list: async () => [], save: async () => undefined, complete: async (_id: string, hash: Hex) => { completedHash = hash; } };
  const request = (async () => new Response(JSON.stringify({ result: { userOpHash: HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TX } } }), { status: 200 })) as typeof fetch;
  const result = await resumePendingConfirmation({ config, account, operation, store, request, entryPoint: ENTRY_POINT, publicClient, verificationPublicClient: publicClient });
  assert.equal(result.status, "success");
  assert.equal(completedHash, HASH);
});

test("an unproven bundler receipt remains persisted for safe investigation or retry", async () => {
  let completed = false;
  const store = { list: async () => [], save: async () => undefined, complete: async () => { completed = true; } };
  const request = (async () => new Response(JSON.stringify({ result: { userOpHash: HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TX } } }), { status: 200 })) as typeof fetch;
  const invalidClient = { getTransactionReceipt: async () => ({ transactionHash: TX, status: "success", logs: [] }) } as never;
  const result = await resumePendingConfirmation({ config, account, operation, store, request, entryPoint: ENTRY_POINT, publicClient: invalidClient, verificationPublicClient: invalidClient });
  assert.equal(result.status, "failed");
  assert.equal(completed, false);
});

test("an independently proven failed UserOperation releases only its persisted hash", async () => {
  let completedHash: Hex | undefined;
  const store = { list: async () => [], save: async () => undefined, complete: async (_id: string, hash: Hex) => { completedHash = hash; } };
  const request = (async () => new Response(JSON.stringify({ result: { userOpHash: HASH, success: false, sender: ACCOUNT, receipt: { transactionHash: TX } } }), { status: 200 })) as typeof fetch;
  const failedEventClient = { getTransactionReceipt: async () => ({
    transactionHash: TX,
    status: "success",
    logs: [{
      address: ENTRY_POINT,
      topics: encodeEventTopics({ abi: [event], eventName: "UserOperationEvent", args: { userOpHash: HASH, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, false, 1n, 1n])
    }]
  }) } as never;
  const result = await resumePendingConfirmation({ config, account, operation, store, request, entryPoint: ENTRY_POINT, publicClient: failedEventClient, verificationPublicClient: failedEventClient });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.error.code, "TRANSACTION_REVERTED");
  assert.equal(completedHash, HASH);
});

test("reconciliation retries temporary lag and does not let one pending record hide another", async () => {
  const secondHash = `0x${"44".repeat(32)}` as Hex;
  const operations = [operation, { ...operation, userOperationHash: secondHash }];
  const completed: Hex[] = [];
  const store = { list: async () => operations, save: async () => undefined, complete: async (_id: string, hash: Hex) => { completed.push(hash); } };
  const attempts = new Map<string, number>();
  const request = (async (_url, init) => {
    const hash = (JSON.parse(String(init?.body)) as { params: [Hex] }).params[0];
    const attempt = (attempts.get(hash) ?? 0) + 1;
    attempts.set(hash, attempt);
    if (hash === HASH && attempt === 1) return new Response(JSON.stringify({ result: null }), { status: 200 });
    if (hash === secondHash) throw new TypeError("temporary network failure");
    return new Response(JSON.stringify({ result: { userOpHash: hash, success: true, sender: ACCOUNT, receipt: { transactionHash: TX } } }), { status: 200 });
  }) as typeof fetch;
  const results = await reconcilePendingOperations({
    config, account, store, request, entryPoint: ENTRY_POINT, publicClient, verificationPublicClient: publicClient,
    maxAttempts: 2, intervalMs: 0, sleep: async () => undefined
  });
  assert.deepEqual(completed, [HASH]);
  assert.equal(results[0]?.status, "success");
  assert.equal(results[1]?.status, "failed");
});
