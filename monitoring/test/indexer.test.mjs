import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";
import { createDashboardMetrics } from "../src/metrics.mjs";
import { createIndexer } from "../src/indexer.mjs";

const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const factory = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const sender = "0x1111111111111111111111111111111111111111";
const account = "0x2222222222222222222222222222222222222222";

function userOpLog({ blockNumber, blockHash, logIndex = 0, gasCost = 1000n, gasUsed = 500n }) {
  return {
    address: entryPoint,
    topics: encodeEventTopics({
      abi: EntryPointAbi,
      eventName: "UserOperationEvent",
      args: { userOpHash: `0x${blockNumber.toString(16).padStart(64, "0")}`, sender, paymaster: "0x0000000000000000000000000000000000000000" }
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [0n, true, gasCost, gasUsed]
    ),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash,
    logIndex: `0x${logIndex.toString(16)}`
  };
}

function accountCreatedLog({ blockNumber, blockHash, logIndex = 0 }) {
  return {
    address: factory,
    topics: encodeEventTopics({ abi: LoomAccountFactoryAbi, eventName: "LoomAccountCreated", args: { account } }),
    data: "0x",
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash,
    logIndex: `0x${logIndex.toString(16)}`
  };
}

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
      userOpLog({ blockNumber: 11, blockHash: `0x${"a2".repeat(32)}` }),
      userOpLog({ blockNumber: 12, blockHash: `0x${"a3".repeat(32)}` })
    ],
    balances: { [account.toLowerCase()]: `0x${(4n * 10n ** 18n).toString(16)}` }
  });

  const metrics = createDashboardMetrics();
  // The manifest is the canonical deployment shape: the indexer reads the
  // factory and EntryPoint straight from it — no manual wiring.
  const indexer = createIndexer({
    rpc,
    metrics,
    manifest: { entryPoint: { address: entryPoint }, factory: { address: factory }, deployBlock: 5 }
  });

  const result = await indexer.sync();
  assert.equal(result.operations, 2);
  assert.equal(result.accounts, 1);
  assert.equal(indexer.cursor, 100);

  const snap = metrics.registry.snapshot();
  const sumByName = name => snap.filter(s => s.name === name).reduce((a, s) => a + s.value, 0);
  assert.equal(sumByName("loom_accounts_total"), 1);
  assert.equal(sumByName("loom_userops_total"), 2);
  assert.equal(snap.find(s => s.name === "loom_tvl_eth").value, 4, "TVL is the account's 4 ETH balance");
});

test("sync is incremental and idempotent: a re-presented log is not double counted", async () => {
  const rpc = fakeChain({
    headBlock: 50,
    logs: [userOpLog({ blockNumber: 20, blockHash: `0x${"b1".repeat(32)}`, logIndex: 3 })]
  });
  const metrics = createDashboardMetrics();
  const indexer = createIndexer({ rpc, metrics, manifest: { entryPoint, factory, startBlock: 0 } });

  await indexer.sync();
  await indexer.sync(); // same log re-presented (overlapping range)
  const total = metrics.registry.snapshot().filter(s => s.name === "loom_userops_total").reduce((a, s) => a + s.value, 0);
  assert.equal(total, 1, "the operation is counted exactly once");
});

test("a manifest without addresses is rejected", () => {
  assert.throws(
    () => createIndexer({ rpc: async () => null, metrics: {}, manifest: { chainId: 31337 } }),
    /must name an EntryPoint and a factory/
  );
});

test("a reorg (block re-presented with a new hash) is counted across syncs on one indexer", async () => {
  let phase = 1;
  const blockHash = { 1: `0x${"b1".repeat(32)}`, 2: `0x${"b2".repeat(32)}` };
  const rpc = async (method) => {
    if (method === "eth_blockNumber") return phase === 1 ? "0xb" : "0xc"; // 11 then 12
    if (method === "eth_getLogs") return [userOpLog({ blockNumber: 11, blockHash: blockHash[phase], logIndex: 0 })];
    if (method === "eth_getBlockByNumber") return { gasLimit: "0x1c9c380", timestamp: "0x0" };
    if (method === "eth_getBalance") return "0x0";
    return null;
  };
  const metrics = createDashboardMetrics({ labels: { chain_id: "31337" } });
  const indexer = createIndexer({ rpc, metrics, manifest: { entryPoint, factory, startBlock: 0 } });

  await indexer.sync(); // block 11 @ b1
  phase = 2;
  await indexer.sync(); // block 11 @ b2 -> reorg of the 1 op previously in b1
  const reorged = metrics.registry.snapshot().find(s => s.name === "loom_userops_reorged_total");
  assert.equal(reorged.value, 1);
});

test("RPC failures are counted through the instrumented transport", async () => {
  const rpc = async (method) => {
    if (method === "eth_blockNumber") return "0x5";
    if (method === "eth_getLogs") throw new Error("provider down");
    return null;
  };
  const metrics = createDashboardMetrics();
  const indexer = createIndexer({ rpc, metrics, manifest: { entryPoint, factory, startBlock: 0 } });
  await assert.rejects(indexer.sync(), /provider down/);
  const errors = metrics.registry.snapshot().find(s => s.name === "loom_rpc_errors_total" && s.labels.method === "eth_getLogs");
  assert.ok(errors && errors.value >= 1, "the failed eth_getLogs is counted");
});
