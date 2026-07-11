# Production Checklist

This example is **pre-production**. Every item below must be satisfied — with
evidence — before shipping a wallet built from this boilerplate. Items map to
`GAPS.md` where applicable.

The device-dependent items (G-001, G-001A, G-006, G-009) are collected into one
evidence bundle: fill `evidence/device-evidence.template.json` during a physical
iOS + Android session and validate it with `npm run evidence:device:check`. See
[`DEVICE_EVIDENCE.md`](DEVICE_EVIDENCE.md).

## Configuration

- [ ] All `configurationReadiness` gates pass (chain, L1 chain, RP id, origin,
      EntryPoint, bundler, factory, passkey validator, P-256 mode).
- [ ] No provider URL, chain id, or origin is assumed by default.

## Deployment (G-002, G-003A)

- [ ] `deployment/manifest.<network>.json` filled from a reproducible deployment.
- [ ] `verifyDeploymentAgainstManifest` passes for the target chain.
- [ ] `verifyManifestCodehashesOnChain` returns no gates for the target chain
      (confirms manifest code hashes against deployed bytecode, including the
      resolved account implementation).
- [ ] Reproducible bytecode, salts, and constructor args verified — a passing
      `verifyManifestCodehashesOnChain` only proves deployed bytecode matches
      the manifest, not that the manifest's hashes came from audited source.
- [ ] P-256 verifier mode evidence: reviewed native precompile, or audited
      fallback verifier with a matching code hash.

## Passkeys (G-001, G-001A)

- [ ] Registration/assertion verified on physical iOS and Android devices.
- [ ] Native RP id and allowed origins pinned; shipped policy matches config.
- [ ] Associated-domain validation and Android signing origin verified.
- [ ] Fresh 32-byte non-zero registration challenge; no static/zero challenge.

## Infrastructure (G-003)

- [ ] At least two independent bundlers qualified; provider switching in UI.
- [ ] Bundler-observability warning shown to users.

## Verified reads (G-006)

- [ ] Helios sync rehearsed on target devices with user-supplied transports.
- [ ] Stale-checkpoint, unavailable-consensus, malformed-proof, and plain-RPC
      downgrade paths tested.

## Recovery (G-004)

- [ ] Guardian ceremony rehearsed with proof-of-possession and encrypted backup.
- [ ] Consumer-mode `unprotected-recovery` prompt shown until setup completes.

## Privacy (G-005)

- [ ] Private send stays disabled until the Railgun adapter profile passes.
- [ ] No analytics/telemetry; no sensitive logs; never-persist list enforced.

## Release hygiene

- [ ] No committed secrets; `EXPO_PUBLIC_` values reviewed as public.
- [ ] Debug logs stripped from release builds.
- [ ] Dependencies pinned and audited.
- [ ] Independent security audit of the wallet client completed.
