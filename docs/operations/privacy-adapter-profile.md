# Privacy Adapter Profile Evidence

`tools/validate-privacy-adapter-profile.mjs` validates the minimum evidence
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

## Non-Goals

- No production private-transfer claim from wrapper tests alone.
- No default Railgun, privacy-pool, Aztec, relayer, indexer, prover, or scanner.
- No private protocol dependency inside Loom core contracts.
- No viewing key, scanning key, private note, or account graph in public state.
- No mandatory Loom server for shield, transfer, unshield, scan, or exit.
