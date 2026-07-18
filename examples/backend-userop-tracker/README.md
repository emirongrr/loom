# backend-userop-tracker

A framework-neutral backend that tracks Loom UserOperations from chain logs. A
backend on Loom is an **observer, sponsor, and session coordinator** — never the
account signer or the source of truth for authority. This example is the
reusable core of such a backend, with no framework, no keys, and no hidden
endpoints: it consumes decoded logs and head numbers and emits status changes
and metrics through callbacks.

```sh
node examples/backend-userop-tracker/index.mjs   # synthetic lifecycle demo
npm --prefix examples/backend-userop-tracker test # the tracker's guarantees
```

## What it does

- **Decodes** EntryPoint `UserOperationEvent` and factory `LoomAccountCreated`
  logs with the canonical `@loom/core` ABIs.
- **Tracks** each operation by `(chainId, entryPoint, userOpHash)` through
  idempotent transitions: `submitted → included → finalized`, plus `dropped`,
  `replaced`, and reorg rollback to `submitted`.
- **Applies a finality policy**: an inclusion is `finalized` only once the head
  advances `confirmations` blocks past its inclusion block.
- **Survives** reorgs (block-hash disagreement rolls affected operations back),
  duplicate events (every step is idempotent), replacement (a new operation on
  the same `sender+nonce` replaces a pending one), and provider disagreement
  (`reconcileReceipt` surfaces a bundler receipt that contradicts the chain).
- **Emits** webhook-shaped events with idempotency keys, so a consumer never
  processes the same transition twice, and OpenTelemetry-shaped metrics
  (submission, inclusion, latency, finalization, reorg, disagreement).
- **Evaluates sponsorship** as a pure, credential-free policy bound to the full
  UserOperation and an expiry — a sponsor decides whether to pay, it never signs.
- **Keeps the user↔account association app-local and private**: the caller hands
  over a hashed user id, and the association never appears in an emitted event.

## Storage

The tracker takes a four-method storage adapter (`get`, `put`, `list`,
`delete`). `createMemoryStore()` is the in-memory implementation used by the
demo and tests; a PostgreSQL-backed adapter implements the same four methods
over a table keyed by the record key, and nothing else changes.

## Evidence

`npm run e2e:bundler-devnet` replays the live devnet's real EntryPoint logs
through this tracker and requires that every operation the send pipeline
submitted is decoded and tracked to `finalized` — the proof that the decoders
and state machine match a real EntryPoint, not just synthetic fixtures.

## Monitoring dashboard

The tracker doubles as the data source for an operator dashboard. Three modules
turn tracked activity into metrics an operator watches:

- `src/metrics.mjs` — a dependency-free metric registry plus an aggregator that
  computes account count, active users, throughput (TPS), gas cost, block-space
  share, and TVL (native balances, plus any ERC-20s you list) from the tracked
  operations and a few read-only balance reads.
- `src/indexer.mjs` — **connects a deployment straight from its manifest** (the
  EntryPoint and factory are read from it — no manual wiring), polls chain logs,
  feeds the tracker, and refreshes the metrics. Incremental and idempotent.
- `src/prometheus.mjs` — renders the metrics as Prometheus exposition text and
  offers a tiny `/metrics` HTTP handler (no Prometheus client library).

Run the exporter against your own RPC and a deployment manifest:

```sh
LOOM_RPC_URL=https://your-rpc \
LOOM_MANIFEST=./deployment/manifest.json \
  node examples/backend-userop-tracker/server.mjs
# metrics on http://localhost:9464/metrics
```

Then bring up Prometheus + Grafana with the provided stack — the `Loom Overview`
dashboard (TVL, active users, TPS, accounts, gas cost, block-space share) is
provisioned automatically:

```sh
docker compose -f examples/backend-userop-tracker/monitoring/docker-compose.yml up
# Grafana at http://localhost:3000 (admin / admin)
```

Exposed series: `loom_accounts_total`, `loom_active_users`, `loom_userops_total`,
`loom_userops_failed_total`, `loom_tps`, `loom_gas_cost_wei_total`,
`loom_gas_cost_wei_avg`, `loom_gas_used_total`, `loom_block_space_fraction`,
`loom_tvl_wei`, `loom_tvl_eth`. The metric shape is OpenTelemetry-compatible
(named series with labels); nothing here mandates a Loom-operated collector.

## Not a package (yet)

Per the SDK architecture guidance, there is no `@loom/backend` until a second
backend consumes the same logic. The canonical ABIs are the reusable parser
primitive; this example is the smallest adequate design. When a second consumer
appears, the decode-and-track core graduates to a package unchanged.
