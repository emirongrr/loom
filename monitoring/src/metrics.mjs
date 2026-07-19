// Dashboard metrics for a Loom deployment.
//
// A thin, dependency-free registry plus an aggregator that turns tracked
// operations and block facts into the numbers an operator watches. It follows
// Prometheus conventions the way a production bundler (Pimlico's Alto) does:
//
//   - monotonic totals are counters with a `_total` suffix, incremented at
//     event time, so `rate()` / `increase()` behave correctly;
//   - dimensions are labels, not baked into metric names (a failed operation is
//     `loom_userops_total{status="failed"}`, not a separate metric);
//   - point-in-time and windowed values (active users, TPS, TVL, indexer lag)
//     are gauges, recomputed on `update()`;
//   - durations are histograms with buckets, so p50/p95/p99 are queryable.
//
// Everything is pure and injectable: operations, block facts, and balances are
// fed in, metrics come out. No network, no collector, no clock it does not own.

// --- registry -------------------------------------------------------------

// prom-client's default histogram buckets (seconds) — a good fit for RPC calls.
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// A minimal Prometheus-compatible registry: counters, gauges, and histograms
// (bucketed) keyed by (name, sorted labels).
export function createMetricsRegistry() {
  const series = new Map(); // key -> counter/gauge entry
  const histograms = new Map(); // key -> { name, labels, buckets: number[], counts: number[], sum, count }

  const keyOf = (name, labels) =>
    Object.keys(labels).length === 0
      ? name
      : `${name}{${Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(",")}}`;

  return {
    counter(name, value = 1, labels = {}) {
      const key = keyOf(name, labels);
      const prev = series.get(key)?.value ?? 0;
      series.set(key, { type: "counter", name, labels: { ...labels }, value: prev + value });
    },
    gauge(name, value, labels = {}) {
      series.set(keyOf(name, labels), { type: "gauge", name, labels: { ...labels }, value });
    },
    // Observe a value into a bucketed histogram (name_bucket / name_sum / name_count).
    observe(name, value, labels = {}, buckets = DEFAULT_BUCKETS) {
      const key = keyOf(name, labels);
      let h = histograms.get(key);
      if (!h) {
        h = { name, labels: { ...labels }, buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
        histograms.set(key, h);
      }
      h.sum += value;
      h.count += 1;
      for (let i = 0; i < h.buckets.length; i += 1) if (value <= h.buckets[i]) h.counts[i] += 1;
    },
    snapshot() {
      const flat = [...series.values()].map(s => ({ ...s, labels: { ...s.labels } }));
      for (const h of histograms.values()) {
        flat.push({
          type: "histogram",
          name: h.name,
          labels: { ...h.labels },
          buckets: h.buckets.map((le, i) => ({ le, count: h.counts[i] })),
          sum: h.sum,
          count: h.count
        });
      }
      return flat;
    }
  };
}

// --- aggregator -----------------------------------------------------------

const WEI_PER_ETH = 10n ** 18n;

/**
 * @param {object} options
 * @param {number} [options.activeWindowSeconds]  rolling window for active users / TPS (default 3600)
 * @param {() => number} [options.now]            clock in ms (default Date.now)
 * @param {object} [options.labels]               deployment identity labels on every series
 */
export function createDashboardMetrics(options = {}) {
  const windowMs = (options.activeWindowSeconds ?? 3600) * 1000;
  const now = options.now ?? (() => Date.now());
  const registry = createMetricsRegistry();

  // Deployment identity labels applied to every series so a single Prometheus /
  // Grafana instance can watch several deployments side by side.
  const baseLabels = options.labels ?? {};

  const accounts = new Set();
  const operations = []; // { sender, blockNumber, tsMs, gasCost (bigint), gasUsed (bigint), success }
  const blocks = new Map(); // number -> { gasLimit (bigint), tsMs }
  let tvlWei = 0n;
  let indexerHead = 0;
  let indexerLag = 0;

  const gauge = (name, value) => registry.gauge(name, value, baseLabels);

  function recordAccount(account) {
    const key = String(account).toLowerCase();
    if (accounts.has(key)) return;
    accounts.add(key);
    registry.counter("loom_accounts_total", 1, baseLabels);
  }

  // A reorg rolled operations back; counted as a monotonic total.
  function recordReorg(count = 1) {
    if (count > 0) registry.counter("loom_userops_reorged_total", count, baseLabels);
  }

  // The indexer's position: the head it has processed to and how far that lags
  // the chain head. Rising lag means the indexer is falling behind.
  function setIndexerHead(head, lag) {
    indexerHead = Number(head);
    indexerLag = Number(lag);
    gauge("loom_indexer_head_block", indexerHead);
    gauge("loom_indexer_lag_blocks", indexerLag);
  }

  // One RPC call's outcome, labelled by provider and method. Feeds the request
  // and error counters and the duration histogram (bucketed).
  function recordRpc({ provider = "primary", method, ok, durationMs }) {
    const labels = { ...baseLabels, provider, method };
    registry.counter("loom_rpc_requests_total", 1, labels);
    if (!ok) registry.counter("loom_rpc_errors_total", 1, labels);
    if (typeof durationMs === "number") registry.observe("loom_rpc_duration_seconds", durationMs / 1000, labels);
  }

  // An operation observed on chain. Counters advance at event time; the raw
  // record feeds the windowed gauges recomputed in update().
  function recordOperation(op) {
    const success = op.success !== false;
    const gasCost = BigInt(op.gasCost ?? 0n);
    const gasUsed = BigInt(op.gasUsed ?? 0n);
    operations.push({ sender: String(op.sender).toLowerCase(), blockNumber: Number(op.blockNumber), tsMs: op.tsMs ?? now(), gasCost, gasUsed, success });
    registry.counter("loom_userops_total", 1, { ...baseLabels, status: success ? "success" : "failed", operation_type: "user-operation" });
    registry.counter("loom_gas_used_total", Number(gasUsed), baseLabels);
    registry.counter("loom_gas_cost_wei_total", Number(gasCost), baseLabels);
  }

  function recordBlock(number, { gasLimit, tsMs }) {
    blocks.set(Number(number), { gasLimit: BigInt(gasLimit ?? 0n), tsMs: tsMs ?? now() });
  }

  function setTvlWei(value) {
    tvlWei = BigInt(value);
  }

  // Recompute the point-in-time and windowed gauges from the raw data.
  function update() {
    const cutoff = now() - windowMs;
    const recent = operations.filter(op => op.tsMs >= cutoff);

    const activeUsers = new Set(recent.map(op => op.sender)).size;
    const totalOps = operations.length;
    const failedOps = operations.filter(op => !op.success).length;

    // Throughput over the actual observed span of the window's operations.
    let tps = 0;
    if (recent.length >= 2) {
      const spanMs = recent[recent.length - 1].tsMs - recent[0].tsMs;
      tps = spanMs > 0 ? (recent.length - 1) / (spanMs / 1000) : 0;
    }

    const gasCostTotal = operations.reduce((sum, op) => sum + op.gasCost, 0n);
    const gasUsedTotal = operations.reduce((sum, op) => sum + op.gasUsed, 0n);
    const avgGasCost = totalOps > 0 ? gasCostTotal / BigInt(totalOps) : 0n;

    // Block-space share: gas Loom operations consumed, over the gas limit of the
    // blocks they landed in — a rough "how much of the chain is Loom" gauge.
    const loomBlockNumbers = new Set(recent.map(op => op.blockNumber));
    let capacity = 0n;
    for (const number of loomBlockNumbers) {
      const block = blocks.get(number);
      if (block) capacity += block.gasLimit;
    }
    const recentGasUsed = recent.reduce((sum, op) => sum + op.gasUsed, 0n);
    const blockSpaceFraction = capacity > 0n ? Number((recentGasUsed * 1_000_000n) / capacity) / 1_000_000 : 0;

    gauge("loom_active_users", activeUsers);
    gauge("loom_tps", Number(tps.toFixed(6)));
    gauge("loom_gas_cost_wei_avg", Number(avgGasCost));
    gauge("loom_block_space_fraction", blockSpaceFraction);
    gauge("loom_tvl_wei", Number(tvlWei));
    gauge("loom_tvl_eth", Number((tvlWei * 1_000_000n) / WEI_PER_ETH) / 1_000_000);

    return {
      accounts: accounts.size,
      activeUsers,
      totalOps,
      failedOps,
      tps,
      gasCostTotal,
      avgGasCost,
      gasUsedTotal,
      blockSpaceFraction,
      tvlWei,
      indexerHead,
      indexerLag
    };
  }

  return {
    registry,
    recordAccount,
    recordOperation,
    recordBlock,
    recordReorg,
    recordRpc,
    setIndexerHead,
    setTvlWei,
    update,
    knownAccounts: () => [...accounts]
  };
}

// --- TVL ------------------------------------------------------------------

// Sum native balances (and, optionally, ERC-20 balances) across the tracked
// accounts. Read-only: an injected `rpc(method, params)` does the reads, so the
// caller keeps full control of which endpoint answers.
export async function computeTvlWei(rpc, accounts, tokens = []) {
  let total = 0n;
  for (const account of accounts) {
    const balance = await rpc("eth_getBalance", [account, "latest"]);
    total += BigInt(balance);
    for (const token of tokens) {
      // balanceOf(address) = 0x70a08231 + padded account.
      const data = `0x70a08231${account.slice(2).toLowerCase().padStart(64, "0")}`;
      const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
      if (typeof result === "string" && result !== "0x") total += BigInt(result);
    }
  }
  return total;
}
