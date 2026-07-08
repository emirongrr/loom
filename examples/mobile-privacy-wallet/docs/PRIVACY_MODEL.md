# Privacy Model

This example is a **privacy-oriented** wallet boilerplate. It is not a private
wallet. Privacy is a layered property, and this document states exactly which
layers the example addresses and which it does not, so no one ships a false
guarantee.

## Privacy layers

| Layer | What it means | Status in this example |
| --- | --- | --- |
| Local privacy | Sensitive material (keys, viewing keys, account graph) is not persisted in plaintext or leaked in logs | **Implemented** — passkey private keys stay in the platform credential manager; the app is documented to never persist raw credential ids, attestation, viewing keys, or account-graph data; no analytics/telemetry. |
| RPC privacy | The RPC provider cannot forge state and does not become the sole trusted source | **Partially implemented** — Helios-first verified reads reduce trust in RPC *responses*; plain RPC is an explicitly `unverified` fallback. See the caveats below. |
| Bundler privacy | The ERC-4337 bundler cannot observe who is transacting | **Not implemented** — a bundler sees every UserOperation (sender, calldata, gas). This is a metadata chokepoint. The app requires an explicit, replaceable bundler and warns about it. |
| Metadata privacy | Network-level observers cannot correlate device, IP, timing | **Not implemented** — out of scope for this boilerplate; documented as a gap. |
| Transaction-graph privacy | On-chain observers cannot link sends/receives | **Not implemented** — ordinary public-chain transfers are fully public. |
| Stealth-address privacy | Recipients are unlinkable per payment | **Not implemented** — future Loom roadmap; no adapter here. |
| Privacy pool / shielded transfers | Amounts and links are hidden by a shielded protocol | **Gated, not enabled** — a Railgun boundary exists but private send stays disabled until a passing privacy adapter profile is configured (`src/flows/privacySendFlow.ts`). |

## What Helios does and does not do

Helios-first verified reads (`src/verified/helios.ts`) let the wallet check state
against a weak-subjectivity checkpoint instead of trusting a raw RPC answer.

- It **may** reduce trust in RPC *responses* (balances, nonces, recovery state).
- It does **not** hide transaction-submission metadata.
- It does **not** replace a bundler.
- It does **not** make public transactions private.
- It still needs user-supplied execution and consensus transports and may fall
  back to plain RPC, which the UI must label `unverified`.

## Honest defaults

- No analytics and no telemetry are included.
- No RPC, bundler, indexer, or relayer default is shipped; every endpoint is
  user-supplied and replaceable (`.env.example`, `configurationReadiness`).
- The UI shows whether transfers are public or gated-private and which providers
  are configured.

## Rule

Do not present this example as delivering transaction, metadata, graph, or
stealth privacy. It delivers **local privacy discipline + verified reads + an
honest, gated path toward shielded transfers**, and nothing more until the
adapters and evidence in `GAPS.md` land.
