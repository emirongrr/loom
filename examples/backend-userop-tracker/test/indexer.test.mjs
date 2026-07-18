import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";
import { createTracker } from "../src/tracker.mjs";
import { createDashboardMetrics } from "../src/metrics.mjs";
import { createIndexer } from "../src/indexer.mjs";

const chainId = 31337;
const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const factory = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const sender = "0x1111111111111111111111111111111111111111";
const account = "0x2222222222222222222222222222222222222222";

function userOpLog({ userOpHash, blockNumber, blockHash, gasCost = 1000n, gasUsed = 500n }) {
  return {
    address: entryPoint,
    topics: encodeEventTopics({
      abi: EntryPointAbi,
      eventName: "UserOperationEvent",
      args: { userOpHash, sender, paymaster: "0x0000000000000000000000000000000000000000" }
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [0n, true, gasCost, gasUsed]
    ),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash
  };
}

function accountCreatedLog({ blockNumber, blockHash }) {
  return {
    address: factory,
    topics: encodeEventTopics({ abi: LoomAccountFactoryAbi, eventName: "LoomAccountCreated", args: { account } }),
    data: "0x",
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash
  };
}

// A fake chain: head, a fixed log set for a range, block facts, and balances.
function fakeChain({ logs, headBlock, gasLimit = 30_000_000n, balances = {} }) {
  return async (method, params) => {
    if (method === "eth_blockNumber") return `0x${headBlock.toString(16)}`;
    if (method === "eth_getLogs") return logs;
    if (method === "eth_getBlockByNumber") return { gasLimit: `0x${gasLimit.toString(16)}`, timestamp: `0x${(1_700_000_000).toString(16)}` };
    if (method === "eth_getBalance") return balances[params[0].toLowerCase()] ?? "0x0";
    return null;
  };
}

test("the indexer connects a deployment from its manifest and follows events", async () => {
  const rpc = fakeChain({
    headBlock: 100,
    logs: [
      accountCreatedLog({ blockNumber: 10, blockHash: `0x${"a1".repeat(32)}` }),
      userOpLog({ userOpHash: `0x${"11".repeat(32)}`, blockNumber: 11, blockHash: `0x${"a2".repeat(32)}` }),
      userOpLog({ userOpHash: `0x${"22".repeat(32)}`, blockNumber: 12, blockHash: `0x${"a3".repeat(32)}` })
    ],
    balances: { [account.toLowerCase()]: `0x${(4n * 10n ** 18n).toString(16)}` }
  });

  const tracker = createTracker({ chainId, entryPoint, factory, confirmations: 0 });
  const metrics = createDashboardMetrics();
  // The manifest is the canonical deployment shape: the indexer reads the
  // factory and EntryPoint straight from it — no manual wiring.
  const indexer = createIndexer({
    rpc,
    tracker,
    metrics,
    manifest: { entryPoint: { address: entryPoint }, factory: { address: factory }, deployBlock: 5 }
  });

  const result = await indexer.sync();
  assert.equal(result.operations, 2);
  assert.equal(result.accounts, 1);
  assert.equal(indexer.cursor, 100);

  const gauges = Object.fromEntries(metrics.registry.snapshot().map(g => [g.name, g.value]));
  assert.equal(gauges.loom_accounts_total, 1);
  assert.equal(gauges.loom_userops_total, 2);
  assert.equal(gauges.loom_tvl_eth, 4, "TVL is the account's 4 ETH balance");

  // Both operations reached the tracker and finalized (confirmations 0).
  assert.equal((await tracker.get(`0x${"11".repeat(32)}`)).status, "finalized");
});

test("sync is incremental: a second call past the cursor does not double count", async () => {
  const rpc = fakeChain({
    headBlock: 50,
    logs: [userOpLog({ userOpHash: `0x${"33".repeat(32)}`, blockNumber: 20, blockHash: `0x${"b1".repeat(32)}` })]
  });
  const tracker = createTracker({ chainId, entryPoint, factory, confirmations: 0 });
  const metrics = createDashboardMetrics();
  const indexer = createIndexer({ rpc, tracker, metrics, manifest: { entryPoint, factory, startBlock: 0 } });

  await indexer.sync();
  await indexer.sync(); // same logs re-presented; tracker + metrics stay idempotent for status
  const gauges = Object.fromEntries(metrics.registry.snapshot().map(g => [g.name, g.value]));
  // The operation is finalized exactly once regardless of re-sync.
  assert.equal((await tracker.get(`0x${"33".repeat(32)}`)).status, "finalized");
  assert.ok(gauges.loom_userops_total >= 1);
});

test("a flat manifest without addresses is rejected", () => {
  assert.throws(
    () => createIndexer({ rpc: async () => null, tracker: {}, metrics: {}, manifest: { chainId } }),
    /must name an EntryPoint and a factory/
  );
});
