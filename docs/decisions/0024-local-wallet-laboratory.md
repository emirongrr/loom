# Wallet laboratory stays outside production authority

Status: accepted
Date: 2026-08-14

## Problem

Loom can prove individual contracts, SDK helpers, browser components, and
UserOperation tracking, but a developer cannot inspect one correlated account
action from intent through finality. Adding observability carelessly could make
a hosted tracer, test key, or privileged instrumentation part of wallet
authority.

## Evidence

The repository already owns a pinned Anvil/EntryPoint/Alto devnet, a complete
SDK bundler lifecycle, a UserOperation tracker, and Prometheus-compatible
monitoring. A measured local run on Node 22 completed the real passkey-style
P-256 operation through Alto and EntryPoint and independently verified its
receipt and state transition. No existing evaluated product spans browser
intent, WebAuthn, SDK construction, bundler state, immutable account execution,
semantic state, and replay without either losing Loom-specific meaning or
requiring hosted infrastructure.

## Options

- Adopt a hosted transaction simulator as the laboratory. Rejected as the
  canonical path because it adds availability, data-retention, and provider
  assumptions and cannot observe the local browser ceremony.
- Build a second devnet, tracker, and telemetry stack. Rejected because it
  duplicates repository-owned infrastructure and creates two meanings of the
  same lifecycle.
- Emit untyped logs from production packages. Rejected because strings are not
  a stable security boundary and would spread test concerns through production.
- Extend the existing devnet with a typed, local artifact recorder and read-only
  developer UI. Chosen.

## Decision

`tools/wallet-lab` owns a versioned, typed run artifact, scenario definition,
replay command, localhost-only artifact server, and diagnostic UI. The existing
`tools/e2e/bundler-devnet.mjs` emits events only when
`LOOM_WALLET_LAB_ARTIFACT` is set. Normal SDK and contract behavior is unchanged.

The canonical Phase 1 store is an atomically written local JSON artifact. It is
portable, reviewable, CI-retainable, and does not require a database. Optional
OpenTelemetry, Tenderly, Blockscout, and second-bundler adapters may enrich
future runs, but none may become required for local execution or wallet
authority.

Correlation uses run, scenario, trace, span, monotonic sequence, chain, account,
UserOperation, transaction, and block identifiers. A simulation, bundler
acceptance, inclusion, and finality are different states. A successful run must
independently match the EntryPoint UserOperation hash, receipt sender,
transaction status, semantic state transition, and explicit finality policy.

Test credentials are deterministic and derived from a scenario seed. Their
private scalar remains inside a Node `KeyObject`, is provisioned into a CDP
virtual authenticator before Playwright tracing starts, is never emitted, and
is strictly prohibited on public chains or with assets of value. The actual
React example is exercised through Saved Wallet unlock, account activation,
and a 123 wei passkey-authorized transfer. A loopback-only Vite proxy exists
only while the lab environment variables are present; it adds no deployed or
production endpoint.

## Residual risks

Phase 1 drives the real React example, Playwright, CDP virtual WebAuthn, SDK,
bundler, EntryPoint, account, validator, hook, and tracker. This is deterministic
browser-to-chain evidence, but not evidence for platform authenticators,
biometrics, browser-specific UX, or mobile hardware; those remain a manual
release matrix.

The JSON artifact is diagnostic evidence, not a cryptographically signed audit
record. Anyone able to modify the file can alter it. The server validates its
shape, binds only to loopback, disables caching, and escapes rendered content,
but consumers must treat imported artifacts as untrusted.

Only Alto is executed in this slice. Rundler compatibility, hosted enrichment,
reorg injection, paymasters, and recovery remain later phases.
