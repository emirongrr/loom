// Dashboard metrics for a Loom backend.
//
// A thin, dependency-free registry plus an aggregator that turns tracked
// operations and block facts into the numbers an operator watches: account
// count, active users, throughput, gas cost, block-space share, and TVL. It is
// OpenTelemetry-shaped (named series with labels) but pulls in no collector —
// the values are exposed however the caller wants, e.g. the Prometheus text
// endpoint in ./prometheus.mjs.
//
// Everything here is pure and injectable: operations, block facts, and balances
// are fed in, gauges come out. No network, no clock it does not own.

// --- registry -------------------------------------------------------------

// A minimal Prometheus/OpenTelemetry-compatible metric registry: counters and
// gauges keyed by (name, sorted labels). Histograms are kept as sum+count so an
// average is derivable without a bucket dependency.
export function createMetricsRegistry() {
  const series = new Map();

  const keyOf = (name, labels) => {
    const parts = Object.keys(labels)
      .sort()
      .map(k => `${k}=${labels[k]}`)
      .join(",");
    return parts ? `${name}{${parts}}` : name;
  };

  function set(type, name, value, labels = {}) {
    series.set(keyOf(name, labels), { type, name, labels: { ...labels }, value });
  }

  return {
    counter(name, value = 1, labels = {}) {
      const key = keyOf(name, labels);
      const prev = series.get(key)?.value ?? 0;
      series.set(key, { type: "counter", name, labels: { ...labels }, value: prev + value });
    },
    gauge(name, value, labels = {}) {
      set("gauge", name, value, labels);
    },
    observe(name, value, labels = {}) {
      this.counter(`${name}_sum`, value, labels);
      this.counter(`${name}_count`, 1, labels);
    },
    snapshot() {
      return [...series.values()].map(s => ({ ...s, labels: { ...s.labels } }));
    }
  };
}

// --- aggregator -----------------------------------------------------------

const WEI_PER_ETH = 10n ** 18n;

/**
 * @param {object} options
 * @param {number} [options.activeWindowSeconds]  rolling window for active users / TPS (default 3600)
 * @param {() => number} [options.now]            clock in ms (default Date.now)
 */
export function createDashboardMetrics(options = {}) {
  const windowMs = (options.activeWindowSeconds ?? 3600) * 1000;
  const now = options.now ?? (() => Date.now());
  const registry = createMetricsRegistry();

  const accounts = new Set();
  const operations = []; // { sender, blockNumber, tsMs, gasCost (bigint), gasUsed (bigint), success }
  const blocks = new Map(); // number -> { gasLimit (bigint), tsMs }
  let tvlWei = 0n;

  function recordAccount(account) {
    accounts.add(String(account).toLowerCase());
  }

  function recordOperation(op) {
    operations.push({
      sender: String(op.sender).toLowerCase(),
      blockNumber: Number(op.blockNumber),
      tsMs: op.tsMs ?? now(),
      gasCost: BigInt(op.gasCost ?? 0n),
      gasUsed: BigInt(op.gasUsed ?? 0n),
      success: op.success !== false
    });
  }

  function recordBlock(number, { gasLimit, tsMs }) {
    blocks.set(Number(number), { gasLimit: BigInt(gasLimit ?? 0n), tsMs: tsMs ?? now() });
  }

  function setTvlWei(value) {
    tvlWei = BigInt(value);
  }

  // Recompute the exported gauges from the accumulated raw data.
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
    // blocks they landed in. A rough "how much of the chain is Loom" gauge.
    const loomBlockNumbers = new Set(recent.map(op => op.blockNumber));
    let capacity = 0n;
    for (const number of loomBlockNumbers) {
      const block = blocks.get(number);
      if (block) capacity += block.gasLimit;
    }
    const recentGasUsed = recent.reduce((sum, op) => sum + op.gasUsed, 0n);
    const blockSpaceFraction = capacity > 0n ? Number((recentGasUsed * 1_000_000n) / capacity) / 1_000_000 : 0;

    registry.gauge("loom_accounts_total", accounts.size);
    registry.gauge("loom_active_users", activeUsers);
    registry.gauge("loom_userops_total", totalOps);
    registry.gauge("loom_userops_failed_total", failedOps);
    registry.gauge("loom_tps", Number(tps.toFixed(6)));
    registry.gauge("loom_gas_cost_wei_total", Number(gasCostTotal));
    registry.gauge("loom_gas_cost_wei_avg", Number(avgGasCost));
    registry.gauge("loom_gas_used_total", Number(gasUsedTotal));
    registry.gauge("loom_block_space_fraction", blockSpaceFraction);
    registry.gauge("loom_tvl_wei", Number(tvlWei));
    registry.gauge("loom_tvl_eth", Number((tvlWei * 1_000_000n) / WEI_PER_ETH) / 1_000_000);

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
      tvlWei
    };
  }

  return {
    registry,
    recordAccount,
    recordOperation,
    recordBlock,
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
