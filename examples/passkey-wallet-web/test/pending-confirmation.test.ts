import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "@loom/core";
import { resumePendingConfirmation } from "../src/services/loom/pendingConfirmation.ts";

const HASH = `0x${"11".repeat(32)}` as Hex;
const TX = `0x${"22".repeat(32)}` as Hex;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const operation = { accountId: "11155111:wallet", userOperationHash: HASH, submittedAt: 1 };
const account = { id: operation.accountId, account: ACCOUNT } as never;
const config = { bundlerUrl: "https://bundler.example" } as never;

test("a null receipt remains pending across reload", async () => {
  let completed = false;
  const store = { list: async () => [], save: async () => undefined, complete: async () => { completed = true; } };
  const request = (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
  const result = await resumePendingConfirmation({ config, account, operation, store, request });
  assert.equal(result.status, "pending");
  assert.equal(completed, false);
});

test("a confirmed receipt completes only the persisted hash", async () => {
  let completedHash: Hex | undefined;
  const store = { list: async () => [], save: async () => undefined, complete: async (_id: string, hash: Hex) => { completedHash = hash; } };
  const request = (async () => new Response(JSON.stringify({ result: { userOpHash: HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TX } } }), { status: 200 })) as typeof fetch;
  const result = await resumePendingConfirmation({ config, account, operation, store, request });
  assert.equal(result.status, "success");
  assert.equal(completedHash, HASH);
});
