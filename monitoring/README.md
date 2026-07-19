# Monitoring

A repository component that turns any Loom deployment into a live dashboard.
Point it at a deployment manifest and it connects the EntryPoint and factory,
follows on-chain activity, and exposes the numbers an operator watches — TVL,
active users, throughput, gas cost, and block-space usage — as Prometheus
metrics that a provisioned Grafana dashboard renders.

It is read-only and framework-neutral: it decodes events with the canonical
`@loom/core` ABIs, takes an injected RPC (no default endpoint), holds no keys,
and mutates nothing.

## Run it against a deployment

Every deployment produces a manifest naming its EntryPoint and factory. Connect
monitoring by pointing at that manifest — from the CLI:

```sh
loom monitor --rpc-url https://your-rpc --manifest ./deployment/manifest.json
```

or directly:

```sh
LOOM_RPC_URL=https://your-rpc \
LOOM_MANIFEST=./deployment/manifest.json \
  node monitoring/server.mjs
# metrics on http://localhost:9464/metrics
```

Optional env: `LOOM_METRICS_PORT` (9464), `LOOM_POLL_INTERVAL_MS` (5000),
`LOOM_TVL_TOKENS` (comma-separated ERC-20 addresses to include in TVL).

## Dashboard

Bring up Prometheus + Grafana with the pinned stack; the **Loom Overview**
dashboard is provisioned automatically:

```sh
docker compose -f monitoring/docker-compose.yml up
# Grafana at http://localhost:3000 (admin / admin)
```

The `docker-compose.yml` stack is the full three-signal topology:

```text
Loom indexer ──(OTLP)──► OpenTelemetry Collector
                            ├── metrics ──► Prometheus ─┐
   /metrics (pull) ────────► Prometheus ────────────────┤
                            └── traces  ──► Tempo ───────┼──► Grafana
                               logs ─────► Loki ─────────┘
```

- **Metrics** answer *what is the system's state?* — pulled from `/metrics` by
  Prometheus (always available, no OTel SDK needed).
- **Traces** answer *which steps did an operation go through?* — emitted as
  spans and, when the operator enables OTLP export, shipped to Tempo/Jaeger.
- **Logs** answer *what happened at a given moment?* — routed to Loki by the
  Collector. (Metric + trace instrumentation is built in; log shipping is a
  Collector concern.)

## Metrics

| Series | Meaning |
| --- | --- |
| `loom_accounts_total` | Accounts created (factory `LoomAccountCreated`). |
| `loom_active_users` | Distinct senders active in the rolling window. |
| `loom_userops_total{status,operation_type}` | Operations observed (a counter; `status="failed"` for reverts). |
| `loom_userops_reorged_total` | Operations rolled back by a reorg. |
| `loom_tps` | UserOperations per second over the window. |
| `loom_gas_cost_wei_total` / `loom_gas_cost_wei_avg` | Gas paid, total and average. |
| `loom_gas_used_total` | Total gas used by Loom operations. |
| `loom_block_space_fraction` | Share of block gas Loom used in the window. |
| `loom_tvl_wei` / `loom_tvl_eth` | Value locked across tracked accounts. |
| `loom_indexer_head_block` / `loom_indexer_lag_blocks` | Indexer position and lag. |
| `loom_rpc_requests_total` / `loom_rpc_errors_total` / `loom_rpc_duration_seconds` | RPC health, by `provider` and `method`. |

Low-cardinality labels: `chain_id`, `entry_point`, `provider`, `method`,
`status`, `operation_type`. Following Prometheus conventions (as Pimlico's Alto
bundler does): monotonic `_total`s are **counters** so `rate()`/`increase()` are
correct, dimensions are **labels** not metric names, and `loom_rpc_duration_seconds`
is a **histogram** (`_bucket`/`_sum`/`_count`) so `histogram_quantile()` gives
p95/p99. The shape is OpenTelemetry-compatible; nothing mandates a Loom collector.

## Traces

The indexer is instrumented with `@opentelemetry/api` (a zero-dependency
interface package), so spans exist whether or not an exporter is wired. Span
names: `index-block-range` (parent), `process-log`, `process-user-operation`,
`detect-reorg`, `calculate-tvl`. Until a TracerProvider is registered they are
no-ops; enable OTLP export (operator-installed SDK, see `src/otel.mjs`) and the
same spans flow to the Collector → Tempo with no code change.

## Alerts

`alerts.yml` ships Prometheus rules loaded by the stack: high UserOperation
failure rate (>5% for 10m), high RPC failure rate per provider (>2% for 5m),
indexer lag (>25 blocks), and reorg activity.

## Try it

```sh
node monitoring/demo.mjs   # synthetic chain -> metrics + trace spans + RPC stats
```

## Layout

- `src/metrics.mjs` — the metric registry and the aggregator.
- `src/indexer.mjs` — manifest-driven, self-contained log decoding, metrics, and spans.
- `src/rpc.mjs` — the measured RPC wrapper (requests, errors, duration).
- `src/telemetry.mjs` — the OpenTelemetry-API span helper.
- `src/otel.mjs` — optional, operator-installed OTLP bootstrap.
- `src/prometheus.mjs` — Prometheus text exposition and the `/metrics` handler.
- `server.mjs` — the runnable exporter (`npm start`, or `loom monitor`).
- `docker-compose.yml` + `otel-collector-config.yaml` + `prometheus.yml` +
  `alerts.yml` + `tempo.yaml` + `grafana/` — the observability stack.

The live proof is `npm run e2e:bundler-devnet`, which connects this component to
the devnet from a manifest and asserts the metrics (including the RPC
instrumentation and labels) computed from real EntryPoint logs.
