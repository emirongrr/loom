// Prometheus text exposition for the dashboard metrics.
//
// Prometheus scrapes an HTTP endpoint that returns metrics in a line-based text
// format; Grafana then queries Prometheus. This renders a metric registry
// snapshot into that format and offers a tiny Node http handler, so the example
// needs no Prometheus client library.

const HELP = {
  loom_accounts_total: "Loom accounts created (from factory LoomAccountCreated).",
  loom_active_users: "Distinct senders with an operation in the active window.",
  loom_userops_total: "UserOperations observed on chain.",
  loom_userops_failed_total: "UserOperations that reverted on chain.",
  loom_tps: "UserOperations per second over the active window.",
  loom_gas_cost_wei_total: "Total actualGasCost paid across operations (wei).",
  loom_gas_cost_wei_avg: "Average actualGasCost per operation (wei).",
  loom_gas_used_total: "Total actualGasUsed across operations.",
  loom_block_space_fraction: "Share of block gas Loom operations consumed in the active window.",
  loom_tvl_wei: "Total value locked across tracked accounts (wei).",
  loom_tvl_eth: "Total value locked across tracked accounts (ETH)."
};

function renderLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map(k => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`).join(",")}}`;
}

// Render a registry snapshot as Prometheus exposition text. TYPE/HELP lines are
// emitted once per metric name; series follow with their labels.
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
      lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
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
