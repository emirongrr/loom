// Runnable monitoring server.
//
//   LOOM_RPC_URL=... LOOM_MANIFEST=./manifest.json node monitoring/server.mjs
//   # or: loom monitor --rpc-url ... --manifest ...
//
// Connects a Loom deployment from its manifest, indexes chain events on an
// interval, and exposes Prometheus metrics on http://localhost:9464/metrics.
// Point Prometheus at that endpoint and Grafana at Prometheus (the sibling
// docker-compose stack does exactly this). No default RPC: the endpoint is yours.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDashboardMetrics } from "./src/metrics.mjs";
import { createIndexer } from "./src/indexer.mjs";
import { createMetricsHandler } from "./src/prometheus.mjs";
import { startOtelIfConfigured } from "./src/otel.mjs";

const rpcUrl = process.env.LOOM_RPC_URL;
const manifestPath = process.env.LOOM_MANIFEST;
const port = Number(process.env.LOOM_METRICS_PORT ?? 9464);
const intervalMs = Number(process.env.LOOM_POLL_INTERVAL_MS ?? 5000);
const tokens = (process.env.LOOM_TVL_TOKENS ?? "").split(",").map(t => t.trim()).filter(Boolean);

if (!rpcUrl || !manifestPath) {
  console.error("set LOOM_RPC_URL and LOOM_MANIFEST (a deployment manifest path)");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Wire OTLP trace export if the operator opted in (endpoint + SDK installed);
// otherwise the spans stay a no-op and only the Prometheus endpoint is used.
const otel = await startOtelIfConfigured();
console.log(otel.enabled ? `OTLP traces -> ${otel.endpoint}` : `OTLP export disabled (${otel.reason})`);

const rpc = async (method, params) => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const chainId = Number(process.env.LOOM_CHAIN_ID ?? manifest.chainId ?? 0) || undefined;
const metrics = createDashboardMetrics({ labels: chainId ? { chain_id: String(chainId) } : {} });
const indexer = createIndexer({ rpc, manifest, metrics, tokens, chainId });

// Serve metrics; each scrape re-renders the latest gauges.
const handler = createMetricsHandler(metrics.registry, { beforeScrape: () => metrics.update() });
createServer((req, res) => handler(req, res)).listen(port, () => {
  console.log(`metrics on http://localhost:${port}/metrics  (entryPoint ${indexer.entryPoint}, factory ${indexer.factory})`);
});

async function poll() {
  try {
    const result = await indexer.sync();
    if (result.operations || result.accounts) {
      console.log(`indexed ${result.from}..${result.to}: +${result.operations} ops, +${result.accounts} accounts`);
    }
  } catch (error) {
    console.error(`sync failed: ${error.message}`);
  }
}
await poll();
setInterval(poll, intervalMs);
