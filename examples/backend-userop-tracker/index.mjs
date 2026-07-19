// Runnable demo of the framework-neutral UserOperation tracker.
//
//   node examples/backend-userop-tracker/index.mjs
//
// It feeds a synthetic operation lifecycle through the tracker — submit,
// on-chain inclusion, a reorg, re-inclusion, then finalization — and prints the
// webhook-shaped events and metrics a real backend would forward. No network,
// no keys; the tracker only consumes logs and head numbers.

import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { EntryPointAbi } from "@loom/core";
import { createTracker, evaluateSponsorship } from "./src/tracker.mjs";

const chainId = 31337;
const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const sender = "0x1111111111111111111111111111111111111111";
const userOpHash = `0x${"ab".repeat(32)}`;

function userOpLog({ blockNumber, blockHash, success = true }) {
  const topics = encodeEventTopics({
    abi: EntryPointAbi,
    eventName: "UserOperationEvent",
    args: { userOpHash, sender, paymaster: "0x0000000000000000000000000000000000000000" }
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [0n, success, 1_257_300_454_211_964n, 1_077_618n]
  );
  return { address: entryPoint, topics, data, blockNumber, blockHash };
}

const events = [];
const metrics = [];
const tracker = createTracker({
  chainId,
  entryPoint,
  confirmations: 3,
  onEvent: e => {
    events.push(e);
    console.log(`  event  ${e.type.padEnd(18)} ${e.record.status}${e.record.block ? ` @${e.record.block.number}` : ""}`);
  },
  onMetric: m => metrics.push(m)
});

// A sponsor backend decides whether to pay — without ever signing.
const decision = evaluateSponsorship(
  { maxCostWei: 5n * 10n ** 15n, allowedSenders: [sender], expiry: Date.now() + 60_000 },
  { sender, maxFeePerGas: 3_000_000_000n, callGasLimit: 500_000n, verificationGasLimit: 900_000n, preVerificationGas: 100_000n }
);
console.log(`sponsorship: ${decision.sponsored ? "APPROVED" : "DECLINED"} (${decision.reason})`);
assert.equal(decision.sponsored, true);

console.log("\n1. backend submits the operation to a bundler");
await tracker.recordSubmitted({ userOpHash, sender, nonce: 0n });

console.log("2. operation is included at block 100 (head 101 — not yet final)");
await tracker.ingest({ logs: [userOpLog({ blockNumber: 100n, blockHash: `0x${"a1".repeat(32)}` })], head: 101 });
assert.equal((await tracker.get(userOpHash)).status, "included");

console.log("3. a reorg replaces block 100 — inclusion is rolled back");
await tracker.ingest({ blocks: [{ number: 100n, hash: `0x${"a2".repeat(32)}` }], head: 101 });
assert.equal((await tracker.get(userOpHash)).status, "submitted");

console.log("4. operation is re-included at block 102, head advances past finality");
await tracker.ingest({ logs: [userOpLog({ blockNumber: 102n, blockHash: `0x${"b1".repeat(32)}` })], head: 106 });
assert.equal((await tracker.get(userOpHash)).status, "finalized");

console.log("5. reconcile a bundler receipt against the chain record");
const reconciliation = await tracker.reconcileReceipt({ userOpHash, success: true });
assert.equal(reconciliation.agreed, true);

console.log(`\nemitted ${events.length} events and ${metrics.length} metrics`);
console.log("metrics:", [...new Set(metrics.map(m => m.name))].join(", "));
console.log("\nbackend-userop-tracker demo: PASS — full lifecycle tracked from logs alone");
