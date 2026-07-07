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

## G-002: Account Deployment Requires Production Configuration

- **Missing API or behavior:** A mobile app needs deployed factory, EntryPoint,
  validator, module, and optional registry addresses plus deployment manifest
  verification before it can submit account creation.
- **Affected flow:** Passkey-first onboarding.
- **Security/privacy impact:** Hardcoded or unverified deployment addresses
  could create accounts with the wrong authority or infrastructure assumption.
- **Proposed fix PR:** Add per-network mobile deployment profiles generated
  from the production deployment manifest.

## G-003: Live Bundler Qualification Is Required

- **Missing API or behavior:** Runtime submission requires caller-provided
  bundler transports and evidence across two independent ERC-4337 bundlers.
- **Affected flow:** Account deployment and transaction send.
- **Security/privacy impact:** A single bundler can become a liveness choke
  point if the app cannot switch providers.
- **Proposed fix PR:** Publish mobile-compatible bundler qualification evidence
  and UI for switching bundlers.

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
