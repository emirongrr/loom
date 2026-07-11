# Mobile Wallet Gaps

This file records the production gaps discovered while wiring the mobile wallet
boilerplate to real Loom flows. A disabled UI path is preferable to a fake
runtime path.

## G-001: Native Passkey Implementations Need Device Evidence

- **Missing API or behavior:** The app includes first-party iOS
  `AuthenticationServices` and Android Credential Manager implementations, but
  store release still requires physical-device registration/assertion evidence,
  associated-domain validation, app signing validation, and native build
  evidence.
- **Affected flow:** Create account, sign UserOperation, session grant, recovery
  setup.
- **Security/privacy impact:** Without physical-device evidence, passkey
  compatibility and client-data parsing cannot be claimed production-ready.
- **Proposed fix PR:** Add physical iOS/Android passkey evidence without
  persisting raw credential identifiers or attestation objects, then attach
  native build logs and store privacy declarations.
- **Evidence template:** `evidence/device-evidence.template.json`, validated by `npm run evidence:device:check` (see `docs/DEVICE_EVIDENCE.md`). The template ships intentionally incomplete; a physical-device session must complete it.

## G-001A: Native Passkey Domain Policy Evidence

- **Missing API or behavior:** The native module now requires build-time RP ID
  and origin policy, but release evidence must prove the shipped iOS
  `Info.plist`, Android merged manifest, associated domains, and Android app
  signing origin match the wallet configuration.
- **Affected flow:** Create account and sign UserOperation.
- **Security/privacy impact:** If native and JS domain policies diverge,
  passkey registration or signing fails closed. If release evidence is missing,
  the app cannot claim production passkey readiness.
- **Proposed fix PR:** Add iOS/Android release-build evidence that records the
  pinned RP ID, allowed origins, associated-domain validation, Android signing
  certificate hash, and negative tests for mismatched RP/origin.
- **Evidence template:** `evidence/device-evidence.template.json`, validated by `npm run evidence:device:check` (see `docs/DEVICE_EVIDENCE.md`). The template ships intentionally incomplete; a physical-device session must complete it.

## G-002: Account Deployment Requires Production Configuration

- **Missing API or behavior:** A mobile app needs deployed factory, EntryPoint,
  validator, module, and optional registry addresses plus deployment manifest
  verification before it can submit account creation.
- **Affected flow:** Passkey-first onboarding.
- **Security/privacy impact:** Hardcoded or unverified deployment addresses
  could create accounts with the wrong authority or infrastructure assumption.
- **Partial mitigation in this example:** `src/loom/deployment/manifest.ts`
  parses a committed manifest and refuses configured addresses that do not match
  it (`verifyDeploymentAgainstManifest`); `deployment/manifest.example.json` is
  the template. Still open: per-network production manifests generated from the
  reproducible deployment, and on-chain code-hash confirmation.
- **Proposed fix PR:** Add per-network mobile deployment profiles generated
  from the production deployment manifest and confirm code hashes on chain.

## G-007: Behavioral Unit Tests Need a TypeScript Test Runner — RESOLVED

- **Resolution:** `test/flows.test.ts` is compiled via `tsconfig.tests.json`
  (`npm run test:flows`) and behaviorally covers `configurationReadiness`,
  `parseDeploymentManifest`, `verifyDeploymentAgainstManifest`, account-creation
  gating, metadata-budget enforcement in private send, and session permission
  constraints. Structure-level release gates remain in
  `test/release-gates.test.mjs`.
- **Still open:** device- and integration-level evidence tracked in G-001,
  G-001A, and G-006; behavioral tests do not replace it.

## G-003: Live Bundler Qualification Is Required

- **Missing API or behavior:** Runtime submission requires caller-provided
  bundler transports and evidence across two independent ERC-4337 bundlers.
- **Affected flow:** Account deployment and transaction send.
- **Security/privacy impact:** A single bundler can become a liveness choke
  point if the app cannot switch providers.
- **Proposed fix PR:** Publish mobile-compatible bundler qualification evidence
  and UI for switching bundlers.

## G-003A: P-256 Verifier Mode Evidence Is Required

- **Missing API or behavior:** The mobile app can display the selected P-256
  verifier mode, but release evidence must prove whether the target chain uses
  a native protocol-level precompile or a fallback verifier contract.
- **Affected flow:** Passkey account creation, signing, guardian verification.
- **Security/privacy impact:** Treating an arbitrary fallback verifier address
  as a trusted verifier could let a malicious or incorrect contract accept
  invalid P-256 signatures.
- **Proposed fix PR:** Publish per-network P-256 verifier evidence in the
  deployment manifest. Native mode needs reviewed precompile support evidence.
  Fallback mode needs audited verifier source, address, and deployed bytecode
  hash.

## G-004: Guardian Ceremony Needs Production Evidence

- **Missing API or behavior:** `@loom/guardian` provides ceremony tooling, but
  mobile release needs proof-of-possession, encrypted backup, usability proof,
  and privacy review evidence for the exact app flow.
- **Affected flow:** Progressive recovery setup.
- **Security/privacy impact:** Guardian recovery could be unusable or leak the
  guardian graph if onboarding is not verified.
- **Proposed fix PR:** Add a mobile guardian ceremony evidence runner and
  encrypted local backup storage.

## G-005: Private Send Is Gated

- **Missing API or behavior:** The privacy boundary exists, but production
  Railgun private transfer requires a passing privacy adapter profile, local
  scan-state rehearsal, relayer/indexer/prover failure evidence, and vault
  interaction evidence.
- **Affected flow:** Private send.
- **Security/privacy impact:** Enabling private send without evidence could leak
  metadata or give users false privacy guarantees.
- **Proposed fix PR:** Add a production Railgun mobile adapter profile and only
  enable private send when the profile is verified.

## G-006: Helios Verified Reads Need Mobile Evidence

- **Missing API or behavior:** The app exposes a Helios-first verified
  state-read runtime and keeps plain RPC as an explicitly unverified fallback.
  Store release still requires physical iOS/Android Helios sync evidence,
  checkpoint-source review, WASM/runtime compatibility evidence, stale
  checkpoint handling, and failure-mode tests.
- **Affected flow:** Balance, nonce, recovery state, guardian roots, vault
  state, validator state.
- **Security/privacy impact:** Without device evidence, the app can wire Helios
  correctly but cannot claim production verified wallet state on mobile.
- **Proposed fix PR:** Add mobile Helios sync evidence for target networks and
  release gates for stale checkpoint, unavailable consensus RPC, malformed
  proof data, and plain-RPC downgrade attempts.
- **Evidence template:** `evidence/device-evidence.template.json`, validated by `npm run evidence:device:check` (see `docs/DEVICE_EVIDENCE.md`). The template ships intentionally incomplete; a physical-device session must complete it.

## G-008: Transport Privacy Is Not Implemented

- **Missing API or behavior:** All network traffic (execution RPC, consensus
  RPC, checkpoint source, bundler, and — when enabled — Railgun relayer,
  indexer, and prover) leaves the device directly. Each provider observes the
  device IP, request timing, and query patterns. There is no proxy, VPN, Tor,
  or mixnet routing, no request batching or decoys, and no timing padding.
- **Affected flow:** Every network-touching flow: verified state reads,
  account deployment, transaction send, private send.
- **Security/privacy impact:** A provider (or a network observer at the
  provider) can build an activity profile and, for the bundler, directly link
  IP to on-chain sender. Shielded transfers reduce on-chain linkage but do not
  hide network metadata; overclaiming here would give users false privacy.
- **Partial mitigation in this example:**
  - The per-endpoint leak surface is documented in `docs/PRIVACY_MODEL.md`
    ("Network metadata"); bundlers are explicit and replaceable (G-003); the
    Railgun metadata budget must be acknowledged before a private send is
    built.
  - `MobileWalletConfiguration.transport` and `.stateTransport` are explicit
    override hooks a fork can use to supply a proxy/VPN/Tor-aware
    `LoomTransportAdapter` or `LoomStateReadTransport` instead of the
    default bundler/RPC transports. `createConfiguredLoomClient` previously
    ignored `config.transport` even though the type declared it — that was a
    silent no-op for any fork that tried to use it; it is now honored
    (`src/loom/client.ts`, `resolveBundlerTransport`).
  - `MobileWalletConfiguration.transportFetch` lets a fork route the
    *default* bundler and plain-RPC transports through a proxy-aware `fetch`
    without writing a full custom transport (`src/loom/client.ts`,
    `src/verified/stateTransport.ts`).
  - This does **not** cover Helios execution/consensus RPC traffic:
    `@a16z/helios`'s public `Config` type has no fetch or proxy hook, so
    verified-state-mode network traffic stays outside app-level reach. See
    "What Helios does and does not do" in `docs/PRIVACY_MODEL.md`.
- **Proposed fix PR:** Publish a vetted transport-privacy setup guide for
  integrators using the override hooks above, and — separately, upstream in
  `@a16z/helios` or via a Helios fork — add a proxy/fetch hook for execution
  and consensus RPC traffic so Helios-mode reads can be covered too.

## G-009: Privacy Hygiene Needs Device Evidence

- **Missing API or behavior:** The hygiene layer is implemented — Android
  FLAG_SECURE and the iOS app-switcher blur (`modules/loom-screen-privacy`),
  allowlisted encrypted local storage (`src/platform/secureStore.ts`), and
  clipboard clearing (`src/platform/clipboardHygiene.ts`) — but store release
  needs physical-device proof: a screenshot/recents-thumbnail block check on
  Android, an app-switcher snapshot check on iOS, keystore/Keychain
  persistence checks after reboot and restore, and clipboard clearing timing
  on both platforms.
- **Affected flow:** Every screen showing balances, addresses, recovery
  state; credential id hash and guardian backup persistence; address copy.
- **Security/privacy impact:** Without device evidence the app cannot claim
  screenshot protection or encrypted-at-rest storage as release properties.
  Note the platform asymmetry: iOS cannot block screenshots at all — only the
  app-switcher snapshot is covered — and the docs must never overclaim this.
- **Proposed fix PR:** Attach device evidence for both platforms and wire the
  store privacy declarations (`docs/DATA_SAFETY.md`) into release review.
- **Evidence template:** `evidence/device-evidence.template.json`, validated by `npm run evidence:device:check` (see `docs/DEVICE_EVIDENCE.md`). The template ships intentionally incomplete; a physical-device session must complete it.
