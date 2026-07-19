// Runnable usage demo of the monitoring component.
//
//   node monitoring/demo.mjs
//
// Drives the indexer against a synthetic chain — account creation, a few
// UserOperations (one failed), an RPC error, and a reorg — then prints the
// three signals a real stack would ship: the Prometheus metrics, the trace
// spans (captured by a tiny in-process tracer registered through the OTel API),
// and the RPC call stats. No network, no OTel SDK, no Docker.

import { trace } from "@opentelemetry/api";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";
import { createDashboardMetrics } from "./src/metrics.mjs";
import { createIndexer } from "./src/indexer.mjs";
import { renderPrometheus } from "./src/prometheus.mjs";

const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const factory = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const account = "0x2222222222222222222222222222222222222222";

// A minimal in-process tracer so the demo can show the spans the component
// emits, without pulling in the full OpenTelemetry SDK. In production you would
// register the SDK instead (see src/otel.mjs) and these spans flow to Tempo.
const spans = [];
trace.setGlobalTracerProvider({
  getTracer: () => ({
    startSpan(name, options) {
      const record = { name, attributes: options?.attributes ?? {}, status: "unset" };
      spans.push(record);
      return {
        setStatus: s => (record.status = s.code === 1 ? "ok" : s.code === 2 ? "error" : "unset"),
        recordException: () => (record.exception = true),
        end: () => {}
      };
    }
  })
});

function opLog({ sender, blockNumber, blockHash, logIndex, success = true }) {
  return {
    address: entryPoint,
    topics: encodeEventTopics({ abi: EntryPointAbi, eventName: "UserOperationEvent", args: { userOpHash: `0x${(logIndex + blockNumber).toString(16).padStart(64, "0")}`, sender, paymaster: "0x0000000000000000000000000000000000000000" } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, success, 1_200_000_000_000_000n, 900_000n]),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash,
    logIndex: `0x${logIndex.toString(16)}`
  };
}
function createdLog({ blockNumber, blockHash }) {
  return { address: factory, topics: encodeEventTopics({ abi: LoomAccountFactoryAbi, eventName: "LoomAccountCreated", args: { account } }), data: "0x", blockNumber: `0x${blockNumber.toString(16)}`, blockHash, logIndex: "0x0" };
}

// One synthetic chain driven by a phase the demo advances between syncs — the
// way a single long-lived indexer polls the same chain repeatedly. Phase 2
// re-presents block 11 with a new hash (a reorg) and injects one RPC failure.
const user1 = "0x1111111111111111111111111111111111111111";
const user2 = "0x3333333333333333333333333333333333333333";
const phases = {
  1: {
    head: 12,
    logs: [
      createdLog({ blockNumber: 10, blockHash: `0x${"a1".repeat(32)}` }),
      opLog({ sender: user1, blockNumber: 11, blockHash: `0x${"b1".repeat(32)}`, logIndex: 0 }),
      opLog({ sender: user1, blockNumber: 11, blockHash: `0x${"b1".repeat(32)}`, logIndex: 1 }),
      opLog({ sender: user2, blockNumber: 12, blockHash: `0x${"c1".repeat(32)}`, logIndex: 0, success: false })
    ]
  },
  2: {
    head: 13,
    logs: [opLog({ sender: user1, blockNumber: 11, blockHash: `0x${"b2".repeat(32)}`, logIndex: 0 })],
    failBalanceOnce: true
  }
};

let phase = 1;
let failed = false;
let rpcErrorsInjected = 0;
const rpc = async (method) => {
  const p = phases[phase];
  if (p.failBalanceOnce && !failed && method === "eth_getBalance") {
    failed = true;
    rpcErrorsInjected += 1;
    throw new Error("simulated provider error");
  }
  if (method === "eth_blockNumber") return `0x${p.head.toString(16)}`;
  if (method === "eth_getLogs") return p.logs;
  if (method === "eth_getBlockByNumber") return { gasLimit: "0x1c9c380", timestamp: `0x${(1_700_000_000).toString(16)}` };
  if (method === "eth_getBalance") return `0x${(3n * 10n ** 18n).toString(16)}`;
  if (method === "eth_call") return `0x${(0n).toString(16).padStart(64, "0")}`;
  return null;
};

const metrics = createDashboardMetrics({ activeWindowSeconds: 24 * 3600, labels: { chain_id: "31337" } });
const manifest = { chainId: 31337, entryPoint: { address: entryPoint }, factory: { address: factory }, deployBlock: 0 };
const indexer = createIndexer({ rpc, metrics, manifest, chainId: 31337 });

console.log("1. first sync: account creation + three operations (one failed)");
const r = await indexer.sync();
console.log(`   indexed ${r.from}..${r.to}: +${r.operations} ops, +${r.accounts} accounts`);

console.log("2. second sync: block 11 comes back with a different hash (reorg) + an RPC error");
phase = 2;
try {
  await indexer.sync();
} catch (error) {
  console.log(`   sync surfaced the RPC error: ${error.message}`);
}
metrics.update();

console.log("\n--- Prometheus metrics ---");
console.log(renderPrometheus(metrics.registry.snapshot()).trim());

console.log("\n--- Trace spans (would flow to Tempo via OTLP) ---");
const counts = spans.reduce((m, s) => ((m[s.name] = (m[s.name] ?? 0) + 1), m), {});
for (const [name, count] of Object.entries(counts)) console.log(`   ${name} x${count}`);

console.log(`\nRPC errors injected: ${rpcErrorsInjected}`);
console.log("\nmonitoring demo: PASS — metrics, traces, and RPC stats from one indexer run");
