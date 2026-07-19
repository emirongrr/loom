// Prometheus text exposition for the dashboard metrics.
//
// Prometheus scrapes an HTTP endpoint that returns metrics in a line-based text
// format; Grafana then queries Prometheus. This renders a metric registry
// snapshot into that format and offers a tiny Node http handler, so the example
// needs no Prometheus client library.

const HELP = {
  loom_accounts_total: "Loom accounts created (from factory LoomAccountCreated).",
  loom_active_users: "Distinct senders with an operation in the active window.",
  loom_userops_total: "UserOperations observed on chain, by status and operation_type.",
  loom_tps: "UserOperations per second over the active window.",
  loom_gas_cost_wei_total: "Total actualGasCost paid across operations (wei).",
  loom_gas_cost_wei_avg: "Average actualGasCost per operation (wei).",
  loom_gas_used_total: "Total actualGasUsed across operations.",
  loom_block_space_fraction: "Share of block gas Loom operations consumed in the active window.",
  loom_tvl_wei: "Total value locked across tracked accounts (wei).",
  loom_tvl_eth: "Total value locked across tracked accounts (ETH).",
  loom_userops_reorged_total: "UserOperations rolled back by a chain reorg.",
  loom_indexer_head_block: "Highest block the indexer has processed.",
  loom_indexer_lag_blocks: "Blocks between the chain head and the indexer.",
  loom_rpc_requests_total: "RPC calls issued, by provider and method.",
  loom_rpc_errors_total: "RPC calls that failed, by provider and method.",
  loom_rpc_duration_seconds: "RPC call duration histogram, by provider and method (seconds)."
};

function renderLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map(k => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`).join(",")}}`;
}

// Render a registry snapshot as Prometheus exposition text. TYPE/HELP lines are
// emitted once per metric name; series follow with their labels. Histograms
// expand to the standard `_bucket` (cumulative, with an `+Inf` bucket), `_sum`,
// and `_count` lines.
export function renderPrometheus(snapshot) {
  const byName = new Map();
  for (const s of snapshot) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const lines = [];
  for (const [name, seriesList] of byName) {
    if (HELP[name]) lines.push(`# HELP ${name} ${HELP[name]}`);
    lines.push(`# TYPE ${name} ${seriesList[0].type}`);
    for (const s of seriesList) {
      if (s.type === "histogram") {
        for (const b of s.buckets) lines.push(`${name}_bucket${renderLabels({ ...s.labels, le: String(b.le) })} ${b.count}`);
        lines.push(`${name}_bucket${renderLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
        lines.push(`${name}_sum${renderLabels(s.labels)} ${s.sum}`);
        lines.push(`${name}_count${renderLabels(s.labels)} ${s.count}`);
      } else {
        lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// A Node http request handler that serves `/metrics` from a registry, calling
// an optional `beforeScrape` hook (e.g. recompute gauges) first. Anything else
// 404s. Read-only.
export function createMetricsHandler(registry, options = {}) {
  const path = options.path ?? "/metrics";
  const beforeScrape = options.beforeScrape;
  return async function handler(req, res) {
    const url = (req.url ?? "").split("?")[0];
    if (url !== path) {
      res.statusCode = 404;
      res.end("not found\n");
      return;
    }
    try {
      if (beforeScrape) await beforeScrape();
      const body = renderPrometheus(registry.snapshot());
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(body);
    } catch (error) {
      res.statusCode = 500;
      res.end(`scrape failed: ${error.message}\n`);
    }
  };
}
