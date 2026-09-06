# Wallet Lab Phase 0 research and coverage review

Reviewed: 2026-08-14

## Executive conclusion

No maintained product supplies Loom's complete browser-to-finality evidence
model. The correct design is a thin Loom-owned correlation and semantic-oracle
layer that integrates existing specialist tools. The Phase 1 implementation
extends the existing devnet and bundler lifecycle; it does not create a second
orchestrator, tracker, monitor, or production trust dependency.

## Current architecture map

```text
passkey wallet example -> @loom/passkey / @loom/sdk -> JSON-RPC + bundler
                                      |                  |
                                      v                  v
                          LoomAccount + modules <- EntryPoint
                                      |
                                      v
                              target contracts

loom devnet: pinned Anvil + Loom deployment + EntryPoint + Alto
e2e driver: real P-256-style signing, SDK fill/sign/submit, receipts
tracker: submitted/included/finalized/dropped/replaced/reorg states
monitoring: structured indexer metrics, Prometheus/Grafana/Tempo/Loki support
Wallet Lab: typed correlation + semantic oracle + artifact + local UI
```

Repository evidence includes `packages/cli/src/devnet.mjs`,
`devnet/versions.json`, `tools/e2e/bundler-devnet.mjs`,
`examples/backend-userop-tracker`, `monitoring`, and
`examples/passkey-wallet-web`.

## Tool evaluation and build-versus-integrate decision

| Capability | Evaluated tool | Evidence and maintenance signal | Decision |
|---|---|---|---|
| Transaction simulation, decoded traces, state/gas diffs | Tenderly Simulator, Debugger, Virtual TestNets, bundles | Official simulation, debugger, and virtual-environment documentation remains active; virtual environments are hosted/commercial | Optional adapter. Never canonical or required |
| Local EVM, snapshot/fork, fuzz/invariants, replay, debugger | Foundry/Forge/Anvil 1.7.1 (repo pin) | Official docs cover persisted replay, invariants, debugger, forks; already deeply used by Loom | Integrate existing pin; do not wrap Forge semantics |
| Canonical bundler | Pimlico Alto 0.0.20 (repo pin) | Active official repository; existing Loom devnet runs it locally | Keep as primary local bundler |
| Independent bundler | Alchemy Rundler | Active Rust repository in 2026; independent implementation | Phase 4 compatibility candidate after v0.9/local profile qualification |
| Reference compatibility | eth-infinitism bundler test executor and public results | Official ERC-4337 conformance project | Integrate in qualification tier, not as lifecycle UI |
| UserOperation explorer/indexer | Blockscout UserOps indexer | Official frontend supports a separate UserOps indexer API host | Optional local/read-only enrichment; Loom tracker remains canonical for tests |
| Browser automation and trace | Playwright Trace Viewer | Maintained official docs; captures actions, DOM, network, source, screenshots; recommends retain-on-failure | Integrated with the real example; traces retained as CI evidence |
| Native WebAuthn automation | Chrome DevTools Protocol WebAuthn domain | Official CDP supports virtual authenticators/credentials | Integrated narrowly; credential provisioning precedes tracing and private state is never serialized |
| Injected wallet automation | Synpress | Current docs center MetaMask/Phantom and cached injected-wallet setup | Do not use for Loom native wallet; reconsider only for dapp-connector tests |
| Solidity property testing | Forge invariants, Echidna, Medusa | All maintained; Loom already uses Forge invariants | Keep Forge in PR; evaluate Echidna/Medusa for independent nightly campaigns |
| Symbolic execution | Halmos | Official maintained project; Loom already has Halmos program | Integrate existing program; link counterexamples into artifacts later |
| Static analysis | Slither 0.11.5 (repo/CI pin) | Active official repository and existing CI | Keep; do not duplicate findings in lab UI |
| Correlated telemetry | OpenTelemetry + existing Prometheus stack | Stable context mechanism; shared conventions; existing monitoring stack | Keep artifact canonical; add optional OTLP export after schema stabilizes |
| Complete Loom semantic lifecycle | None | Specialist tools stop at browser, RPC, EVM, or generic telemetry boundaries | Build the small typed correlation/oracle/UI layer |

Primary sources:

- Tenderly: https://docs.tenderly.co/simulations/overview,
  https://docs.tenderly.co/debugger/overview,
  https://docs.tenderly.co/virtual-environments/overview
- Foundry: https://getfoundry.sh/forge/invariant-testing,
  https://getfoundry.sh/forge/replay-testing,
  https://getfoundry.sh/forge/debugger
- ERC-4337: https://github.com/eth-infinitism/account-abstraction/releases,
  https://github.com/eth-infinitism/bundler-test-executor
- Bundlers: https://github.com/pimlicolabs/alto,
  https://github.com/alchemyplatform/rundler
- Browser: https://playwright.dev/docs/trace-viewer,
  https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/,
  https://w3c.github.io/webauthn/
- Telemetry: https://opentelemetry.io/docs/concepts/,
  https://opentelemetry.io/docs/specs/semconv/general/
- Security tools: https://github.com/crytic/echidna,
  https://github.com/crytic/medusa,
  https://github.com/a16z/halmos,
  https://github.com/crytic/slither

## Coverage-gap matrix

| Boundary | Before this change | Phase 1 evidence | Gap |
|---|---|---|---|
| Environment identity | Pinned versions and owned PIDs | Versions, chain, addresses, runtime hashes in artifact | Port collision shown only in CLI |
| UI intent | Browser component tests | Real Saved Wallet unlock, activation, send form, screenshot, and Playwright trace | No accessibility-tree diff or visual regression gate |
| WebAuthn | Contract fixtures and software P-256 E2E | CDP virtual authenticator plus RP ID/origin/UP/UV assertion and on-chain P-256 validation | No physical authenticator or cross-browser matrix |
| SDK construction | Unit/integration tests | Prepared intent, gas fields, packed/unpacked UserOp, independent hash | Source mapping is file/symbol only |
| Bundler | Alto smoke/lifecycle | Estimation, acceptance, inclusion separated | No mempool/second bundler view |
| EntryPoint/account | Contract tests and on-chain lifecycle | Receipt provenance and semantic state oracle | No decoded call tree/gas hierarchy |
| Finality/reorg | Tracker tests | Explicit one-block local finality | No injected reorg in lab runner |
| Replay | Individual Forge failure persistence | Versioned scenario seed and clean-devnet replay command | No snapshot archive/minimizer yet |
| Failure evidence | Logs and CI files | First boundary, redacted error, incremental JSON, screenshot, browser/network trace | No HAR import/export or automatic minimizer |

## Baseline and measured evidence

- Node 22.18.0 is required. The system default Node 23.4.0 is outside the
  repository support profile.
- A clean root install does not install `packages/privacy`; `verify:quick`
  imports that package, so `npm --prefix packages/privacy ci` is required first
  in this worktree. This is a pre-existing clean-checkout ergonomics gap.
- `npm run verify:quick` passed after selecting Node 22 and installing the
  privacy package; observed wall time was approximately 594 seconds.
- The instrumented Anvil/Alto operation passed locally in approximately 21
  seconds after dependencies were built. It emitted 12 lifecycle events and
  five passing independent invariants.

These are observations, not budgets. CI thresholds remain disabled until at
least 20 comparable samples exist. Proposed tiers:

| Tier | Contents | Initial target | Artifact/flake policy |
|---|---|---|---|
| PR fast | schema, redaction, server, deterministic identity unit tests | under 1 minute | no retry for product failures |
| PR integration | one Alto local lifecycle | existing 30-minute job envelope | retain run/logs 30 days; one infra-only retry may be manually classified |
| Security-sensitive PR | relevant fuzz/invariants, browser passkey once added | measured before gating | seed and trace retained on every failure |
| Nightly | scenario matrix, faults, fork tokens, longer invariants | to be measured | retain 90 days; deterministic failures never retried away |
| Weekly deep | second bundler, reorg, mutation, symbolic campaigns | to be measured | retain minimized counterexamples |
| Release/manual | real-device matrix and release evidence | human scheduled | signed evidence index; no production credential in artifacts |

## Rollout

The Phase 1 vertical slice now includes Playwright, a CDP virtual authenticator,
and the actual passkey wallet example on the local profile. Phase 2 adds token,
batching, sponsorship, validators/hooks, sessions, and deterministic fault
adapters. Phase 3 adds full recovery. Phase 4 adds Rundler, reorgs, comparison,
symbolic/mutation evidence, and pinned fork matrices.
