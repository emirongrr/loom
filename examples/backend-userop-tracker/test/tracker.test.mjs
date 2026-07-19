import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, pad } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";
import { createTracker, createMemoryStore, evaluateSponsorship } from "../src/tracker.mjs";

const chainId = 31337;
const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const factory = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const sender = "0x1111111111111111111111111111111111111111";

// Build a raw UserOperationEvent log exactly as an EntryPoint emits it.
function userOpLog({ userOpHash, nonce = 0n, success = true, cost = 1000n, used = 900n, blockNumber, blockHash, paymaster = "0x0000000000000000000000000000000000000000" }) {
  const topics = encodeEventTopics({
    abi: EntryPointAbi,
    eventName: "UserOperationEvent",
    args: { userOpHash, sender, paymaster }
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [nonce, success, cost, used]
  );
  return { address: entryPoint, topics, data, blockNumber, blockHash };
}

function accountCreatedLog({ account, blockNumber, blockHash }) {
  const topics = encodeEventTopics({ abi: LoomAccountFactoryAbi, eventName: "LoomAccountCreated", args: { account } });
  return { address: factory, topics, data: "0x", blockNumber, blockHash };
}

const hash = n => `0x${String(n).padStart(64, "0")}`;

test("submitted -> included -> finalized under the finality policy", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, confirmations: 3, onEvent: e => events.push(e) });

  await tracker.recordSubmitted({ userOpHash: hash(1), sender, nonce: 0n });
  assert.equal((await tracker.get(hash(1))).status, "submitted");

  // Included at block 100; head 101 is not yet final (needs 100 + 3).
  await tracker.ingest({ logs: [userOpLog({ userOpHash: hash(1), blockNumber: 100n, blockHash: hash(0xaa) })], head: 101 });
  assert.equal((await tracker.get(hash(1))).status, "included");

  // Head reaches finality depth.
  await tracker.ingest({ head: 103 });
  assert.equal((await tracker.get(hash(1))).status, "finalized");

  assert.deepEqual(
    events.map(e => e.type),
    ["userop.submitted", "userop.included", "userop.finalized"]
  );
});

test("re-ingesting the same log is idempotent (no duplicate webhook events)", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, confirmations: 1, onEvent: e => events.push(e) });
  const log = userOpLog({ userOpHash: hash(2), blockNumber: 10n, blockHash: hash(0xbb) });

  await tracker.ingest({ logs: [log], head: 10 });
  await tracker.ingest({ logs: [log], head: 10 });
  await tracker.ingest({ logs: [log], head: 12 }); // now finalizes

  const included = events.filter(e => e.type === "userop.included");
  const finalized = events.filter(e => e.type === "userop.finalized");
  assert.equal(included.length, 1, "inclusion emitted exactly once");
  assert.equal(finalized.length, 1, "finalization emitted exactly once");
});

test("a reorg rolls an included operation back to submitted", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, confirmations: 5, onEvent: e => events.push(e) });

  await tracker.ingest({ logs: [userOpLog({ userOpHash: hash(3), blockNumber: 50n, blockHash: hash(0xc1) })], head: 51 });
  assert.equal((await tracker.get(hash(3))).status, "included");

  // Block 50 comes back with a different hash: the earlier inclusion is void.
  await tracker.ingest({ blocks: [{ number: 50n, hash: hash(0xc2) }], head: 51 });
  assert.equal((await tracker.get(hash(3))).status, "submitted");
  assert.ok(events.some(e => e.type === "userop.reorged"));
});

test("a second operation on the same sender+nonce replaces the first", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, onEvent: e => events.push(e) });
  await tracker.recordSubmitted({ userOpHash: hash(4), sender, nonce: 7n });
  await tracker.recordSubmitted({ userOpHash: hash(5), sender, nonce: 7n });

  assert.equal((await tracker.get(hash(4))).status, "replaced");
  assert.equal((await tracker.get(hash(5))).status, "submitted");
  assert.ok(events.some(e => e.type === "userop.replaced"));
});

test("receipt reconciliation surfaces bundler/chain disagreement", async () => {
  const metrics = [];
  const tracker = createTracker({ chainId, entryPoint, confirmations: 1, onMetric: m => metrics.push(m) });
  await tracker.ingest({ logs: [userOpLog({ userOpHash: hash(6), success: false, blockNumber: 5n, blockHash: hash(0xd1) })], head: 5 });

  const agree = await tracker.reconcileReceipt({ userOpHash: hash(6), success: false });
  assert.equal(agree.agreed, true);

  const disagree = await tracker.reconcileReceipt({ userOpHash: hash(6), success: true });
  assert.equal(disagree.agreed, false);
  assert.match(disagree.reason, /disagree on success/);
  assert.ok(metrics.some(m => m.name === "provider.disagreement"));

  const missing = await tracker.reconcileReceipt({ userOpHash: hash(999), success: true });
  assert.equal(missing.agreed, false);
});

test("an operation seen on chain without a prior submit is adopted", async () => {
  const tracker = createTracker({ chainId, entryPoint, confirmations: 1 });
  await tracker.ingest({ logs: [userOpLog({ userOpHash: hash(7), blockNumber: 3n, blockHash: hash(0xe1) })], head: 3 });
  const record = await tracker.get(hash(7));
  assert.equal(record.status, "included");
  assert.equal(record.sender, sender);
});

test("dropped operations transition only from submitted", async () => {
  const tracker = createTracker({ chainId, entryPoint, confirmations: 1 });
  await tracker.recordSubmitted({ userOpHash: hash(8), sender, nonce: 1n });
  await tracker.markDropped(hash(8));
  assert.equal((await tracker.get(hash(8))).status, "dropped");

  // An operation already on chain (here finalized: head 4 >= block 2 + 1) cannot
  // be marked dropped.
  await tracker.ingest({ logs: [userOpLog({ userOpHash: hash(9), blockNumber: 2n, blockHash: hash(0xe2) })], head: 4 });
  assert.equal((await tracker.get(hash(9))).status, "finalized");
  await tracker.markDropped(hash(9));
  assert.equal((await tracker.get(hash(9))).status, "finalized");
});

test("factory account-creation logs are decoded and emitted", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, factory, onEvent: e => events.push(e) });
  const account = "0x2222222222222222222222222222222222222222";
  const { created } = await tracker.ingest({ logs: [accountCreatedLog({ account, blockNumber: 1n, blockHash: hash(0xf1) })], head: 1 });
  assert.deepEqual(created, [account]);
  assert.ok(events.some(e => e.type === "account.created"));
});

test("user-to-account association is private and never leaks into events", async () => {
  const events = [];
  const tracker = createTracker({ chainId, entryPoint, onEvent: e => events.push(e) });
  // The caller hashes the user id before handing it over.
  const hashedUser = hash(0x1234);
  tracker.associate(hashedUser, sender);
  assert.equal(tracker.resolveAccount(hashedUser), sender.toLowerCase());

  await tracker.recordSubmitted({ userOpHash: hash(10), sender, nonce: 2n });
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes(hashedUser), false, "hashed user id must not appear in any event");
  }
});

test("sponsorship evaluation is pure, credential-free, and bound to op + expiry", () => {
  const userOp = {
    sender,
    maxFeePerGas: 2_000_000_000n,
    callGasLimit: 100_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 50_000n
  };
  // maxCost = 2e9 * 650000 = 1.3e15
  assert.equal(evaluateSponsorship({ maxCostWei: 2n * 10n ** 15n }, userOp).sponsored, true);
  assert.equal(evaluateSponsorship({ maxCostWei: 10n ** 12n }, userOp).sponsored, false);
  assert.equal(evaluateSponsorship({ allowedSenders: ["0x9999999999999999999999999999999999999999"] }, userOp).sponsored, false);
  assert.equal(evaluateSponsorship({ expiry: 1000 }, userOp, 2000).sponsored, false);
});

test("the memory store round-trips independent copies", async () => {
  const store = createMemoryStore();
  await store.put("k", { a: 1, nested: { b: 2 } });
  const first = await store.get("k");
  first.nested.b = 99;
  assert.equal((await store.get("k")).nested.b, 2, "stored value is not aliased");
  assert.equal((await store.list()).length, 1);
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});
