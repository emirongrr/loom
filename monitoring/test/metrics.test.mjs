import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardMetrics, createMetricsRegistry, computeTvlWei } from "../src/metrics.mjs";
import { renderPrometheus } from "../src/prometheus.mjs";

test("the registry accumulates counters and overwrites gauges, keyed by labels", () => {
  const r = createMetricsRegistry();
  r.counter("ops", 1, { sender: "a" });
  r.counter("ops", 2, { sender: "a" });
  r.counter("ops", 1, { sender: "b" });
  r.gauge("tvl", 100);
  r.gauge("tvl", 250);
  const byKey = Object.fromEntries(r.snapshot().map(s => [`${s.name}:${s.labels.sender ?? ""}`, s.value]));
  assert.equal(byKey["ops:a"], 3);
  assert.equal(byKey["ops:b"], 1);
  assert.equal(byKey["tvl:"], 250);
});

test("dashboard metrics compute accounts, active users, gas, and TVL", () => {
  let clock = 1_000_000;
  const m = createDashboardMetrics({ activeWindowSeconds: 3600, now: () => clock });

  m.recordAccount("0xAAA");
  m.recordAccount("0xaaa"); // same account, different case
  m.recordAccount("0xBBB");

  m.recordOperation({ sender: "0x1", blockNumber: 10, tsMs: clock, gasCost: 1000n, gasUsed: 500n, success: true });
  m.recordOperation({ sender: "0x1", blockNumber: 11, tsMs: clock + 1000, gasCost: 3000n, gasUsed: 700n, success: true });
  m.recordOperation({ sender: "0x2", blockNumber: 11, tsMs: clock + 2000, gasCost: 2000n, gasUsed: 800n, success: false });
  m.recordBlock(10, { gasLimit: 30_000_000n, tsMs: clock });
  m.recordBlock(11, { gasLimit: 30_000_000n, tsMs: clock + 1000 });
  m.setTvlWei(5n * 10n ** 18n);

  clock += 3000;
  const s = m.update();

  assert.equal(s.accounts, 2, "distinct accounts, case-insensitive");
  assert.equal(s.activeUsers, 2);
  assert.equal(s.totalOps, 3);
  assert.equal(s.failedOps, 1);
  assert.equal(s.gasCostTotal, 6000n);
  assert.equal(s.avgGasCost, 2000n);
  assert.equal(s.tvlWei, 5n * 10n ** 18n);
  assert.ok(s.tps > 0, "throughput is positive with multiple ops");
  // Block space: recent gasUsed 2000 over two blocks' 60M limit -> tiny but > 0.
  assert.ok(s.blockSpaceFraction > 0 && s.blockSpaceFraction < 1);

  const gauges = Object.fromEntries(m.registry.snapshot().map(g => [g.name, g.value]));
  assert.equal(gauges.loom_accounts_total, 2);
  assert.equal(gauges.loom_tvl_eth, 5);
});

test("operations outside the active window drop out of active users and TPS", () => {
  let clock = 10_000_000;
  const m = createDashboardMetrics({ activeWindowSeconds: 10, now: () => clock });
  m.recordOperation({ sender: "0x1", blockNumber: 1, tsMs: clock, gasCost: 1n, gasUsed: 1n });
  clock += 60_000; // 60s later, window is 10s
  m.recordOperation({ sender: "0x2", blockNumber: 2, tsMs: clock, gasCost: 1n, gasUsed: 1n });
  const s = m.update();
  assert.equal(s.totalOps, 2, "lifetime total keeps both");
  assert.equal(s.activeUsers, 1, "only the recent sender is active");
});

test("computeTvlWei sums native balances and ERC-20 balanceOf across accounts", async () => {
  const rpc = async (method, params) => {
    if (method === "eth_getBalance") return params[0] === "0xa" ? "0x2" : "0x3"; // 2 + 3 wei native
    if (method === "eth_call") return `0x${(10n).toString(16).padStart(64, "0")}`; // 10 tokens each
    return null;
  };
  const tvl = await computeTvlWei(rpc, ["0xa", "0xb"], ["0xtoken"]);
  assert.equal(tvl, 2n + 3n + 10n + 10n);
});

test("prometheus rendering emits TYPE lines and label syntax", () => {
  const r = createMetricsRegistry();
  r.gauge("loom_tvl_wei", 42);
  r.counter("loom_userops_total", 3, { chainId: "31337" });
  const text = renderPrometheus(r.snapshot());
  assert.match(text, /# TYPE loom_tvl_wei gauge/);
  assert.match(text, /loom_tvl_wei 42/);
  assert.match(text, /loom_userops_total\{chainId="31337"\} 3/);
  assert.match(text, /# HELP loom_tvl_wei/);
});

test("the metrics HTTP handler serves /metrics and 404s elsewhere", async () => {
  const { createMetricsHandler } = await import("../src/prometheus.mjs");
  const r = createMetricsRegistry();
  let scrapes = 0;
  const handler = createMetricsHandler(r, { beforeScrape: () => { scrapes += 1; r.gauge("loom_tvl_wei", 7); } });

  const respond = () => {
    const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ?? ""; } };
    return res;
  };

  const ok = respond();
  await handler({ url: "/metrics" }, ok);
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /loom_tvl_wei 7/);
  assert.match(ok.headers["content-type"], /text\/plain/);
  assert.equal(scrapes, 1, "beforeScrape ran once");

  const missing = respond();
  await handler({ url: "/healthz" }, missing);
  assert.equal(missing.statusCode, 404);
});

test("reorg, RPC, and indexer-head metrics are recorded with labels", () => {
  const m = createDashboardMetrics({ labels: { chain_id: "31337" } });
  m.recordReorg(2);
  m.recordRpc({ provider: "primary", method: "eth_getLogs", ok: true, durationMs: 12 });
  m.recordRpc({ provider: "primary", method: "eth_getLogs", ok: false, durationMs: 30 });
  m.recordRpc({ provider: "fallback", method: "eth_call", ok: true, durationMs: 5 });
  m.setIndexerHead(500, 3);
  m.update();

  const snap = m.registry.snapshot();
  const byKey = Object.fromEntries(snap.map(s => [`${s.name}|${s.labels.provider ?? ""}|${s.labels.method ?? ""}`, s.value]));
  assert.equal(byKey["loom_userops_reorged_total||"], 2);
  assert.equal(byKey["loom_indexer_head_block||"], 500);
  assert.equal(byKey["loom_indexer_lag_blocks||"], 3);
  assert.equal(byKey["loom_rpc_requests_total|primary|eth_getLogs"], 2);
  assert.equal(byKey["loom_rpc_errors_total|primary|eth_getLogs"], 1);
  assert.equal(byKey["loom_rpc_requests_total|fallback|eth_call"], 1);

  // Reorg and RPC totals are counters (rate() works); duration is a histogram.
  assert.equal(snap.find(s => s.name === "loom_userops_reorged_total").type, "counter");
  assert.equal(snap.find(s => s.name === "loom_rpc_requests_total").type, "counter");
  const hist = snap.find(s => s.type === "histogram" && s.name === "loom_rpc_duration_seconds" && s.labels.method === "eth_getLogs");
  assert.equal(hist.count, 2);
  assert.ok(hist.sum > 0 && Array.isArray(hist.buckets));

  // Every base series carries the chain_id label.
  assert.equal(snap.find(s => s.name === "loom_userops_reorged_total").labels.chain_id, "31337");
});

test("userops are counted by status label, not a separate failed metric", () => {
  const m = createDashboardMetrics();
  m.recordOperation({ sender: "0x1", blockNumber: 1, gasCost: 1n, gasUsed: 1n, success: true });
  m.recordOperation({ sender: "0x2", blockNumber: 1, gasCost: 1n, gasUsed: 1n, success: false });
  m.recordOperation({ sender: "0x3", blockNumber: 1, gasCost: 1n, gasUsed: 1n, success: true });
  const snap = m.registry.snapshot().filter(s => s.name === "loom_userops_total");
  const byStatus = Object.fromEntries(snap.map(s => [s.labels.status, s.value]));
  assert.equal(byStatus.success, 2);
  assert.equal(byStatus.failed, 1);
  assert.equal(snap.every(s => s.type === "counter"), true);
  // No separate loom_userops_failed_total metric exists.
  assert.equal(m.registry.snapshot().some(s => s.name === "loom_userops_failed_total"), false);
});

test("histograms render as _bucket / _sum / _count with an +Inf bucket", () => {
  const r = createMetricsRegistry();
  r.observe("loom_rpc_duration_seconds", 0.03, { method: "eth_call" });
  r.observe("loom_rpc_duration_seconds", 2, { method: "eth_call" });
  const text = renderPrometheus(r.snapshot());
  assert.match(text, /# TYPE loom_rpc_duration_seconds histogram/);
  assert.match(text, /loom_rpc_duration_seconds_bucket\{le="\+Inf"[^}]*\} 2/);
  assert.match(text, /loom_rpc_duration_seconds_count\{method="eth_call"\} 2/);
  assert.match(text, /loom_rpc_duration_seconds_sum\{method="eth_call"\} 2\.03/);
});
