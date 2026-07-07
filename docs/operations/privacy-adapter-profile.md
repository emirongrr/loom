# Privacy Adapter Profile Evidence

`tools/evidence/validate-privacy-adapter-profile.mjs` validates the minimum evidence
required before a Railgun, privacy-pool, or Aztec adapter can be described as a
production-candidate Loom private-transfer adapter.

This profile does not make any privacy protocol part of Loom account authority.
It proves the opposite: private transfer support must remain behind an SDK
adapter, require user consent, preserve local scanning and native exit, and
avoid mandatory Loom-operated infrastructure.

## Required Properties

Each production-candidate profile must include:

- protocol family: `railgun`, `privacy-pool`, or `aztec`;
- exact dependency package, pinned version, license review, audit review, and
  review reference;
- provider mode with no default endpoint and explicit user consent;
- metadata budget tests proving no viewing-key disclosure, no full account
  graph disclosure, and telemetry disabled;
- local-first incremental scan state scoped by account, application, and scan
  scope;
- fail-closed stale-scan policy;
- shield, private transfer, and unshield operations bound to permission,
  maximum fee, and expiry;
- vault delay for protected-asset unshield flows;
- failure classification for indexer, relayer, prover, RPC, and timing errors;
- indexer failure tests proving failed sync does not mutate checkpoints;
- relayer evidence proving relayers are optional, never mandatory;
- live rehearsal evidence proving the adapter used the pinned production SDK,
  not a mock protocol;
- local scan evidence proving scoped checkpoints advanced, stale checkpoints
  were rejected, and scoped reset behavior was tested;
- shield, private transfer, and unshield operation evidence with metadata
  budget hashes, permission hashes, fee bounds, expiries, and successful
  receipts;
- vault-protected unshield evidence with private operation hash, vault intent
  hash, delayed schedule transaction, delayed execute transaction, and delay
  duration;
- service evidence for indexer, relayer, and prover origins, including tested
  and classified failure behavior, with each service marked optional;
- native Loom exit fallback and no account-wide authority for the adapter.

Aztec profiles additionally require bridge-finality review because the adapter
crosses a private L2 execution boundary.

## Command

```sh
npm run privacy:profile:check -- evidence/privacy/<protocol>-<network>.json
```

Production evidence files should be added only after live rehearsal with the
actual protocol dependency, network, relayer/indexer/prover behavior, and vault
interaction path.

For Railgun, Loom's SDK adapter must exercise the upstream Kohaku Railgun
plugin methods directly: `instanceId`, `prepareShield`, `prepareTransfer`,
`prepareUnshield`, and `broadcast`. Evidence from a Loom-only mock plugin is
not sufficient for a production private-transfer claim.

## Rehearsal Evidence

The `rehearsal` section is the production claim boundary. It must show that the
adapter executed through the pinned dependency package and version, crossed the
Loom privacy host boundary, and avoided mock protocol paths.

Required rehearsal fields:

- `network`: chain id, environment (`testnet` or `mainnet`), and network name;
- `sdkIntegration`: dependency package, dependency version, `mockProtocol:
  false`, `kohakuHostBoundary: true`, and a review reference;
- `localScan`: storage scope hash, initial checkpoint hash, final checkpoint
  hash, stale checkpoint rejection, and scoped reset testing;
- `operations.shield`, `operations.privateTransfer`, and
  `operations.unshield`: operation id, metadata budget hash, permission hash,
  expiry, fee bound, and successful receipt status;
- `operations.vaultProtectedUnshield`: private operation hash, vault intent
  hash, delayed schedule transaction hash, delayed execute transaction hash,
  and delay duration;
- `services.indexer`, `services.relayer`, and `services.prover`: service kind,
  URL origin only, `mandatory: false`, failure-mode test evidence, and
  classified failure behavior.

The validator intentionally rejects provider URLs with paths, query strings, or
fragments. Evidence may identify a service origin, but it must not commit an
account, viewing key, app scope, note id, or user-specific query into a reusable
profile.

## Non-Goals

- No production private-transfer claim from wrapper tests alone.
- No production private-transfer claim from mock protocol rehearsal.
- No default Railgun, privacy-pool, Aztec, relayer, indexer, prover, or scanner.
- No private protocol dependency inside Loom core contracts.
- No viewing key, scanning key, private note, or account graph in public state.
- No mandatory Loom server for shield, transfer, unshield, scan, or exit.
