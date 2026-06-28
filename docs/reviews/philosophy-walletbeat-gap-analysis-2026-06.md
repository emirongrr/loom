# Philosophy-Grounded Gap Analysis

Review date: 2026-06-20

Citations valid as of commit `d730b8f` (2026-06-28). Several commits after the
review date touched `src/account/LoomAccount.sol` and `src/hooks/VaultHook.sol`
with line ranges this review cites (notably the addition of
`evictHookWithGuardians`, decision 0005, and the `MIN_VAULT_DELAY`/
`MAX_SCHEDULE_DELAY` constants, decisions 0006-0007). Re-validate specific
`:line` citations against the current file before treating this review's code
references as current; the top-level conclusions (no production L1 verifier,
no live adapter, no production deployment evidence) remain accurate.

Scope: repository state after the wallet-engine SDK merge and before any
production deployment. This is not an independent security audit. It is a
source-backed readiness review against Loom's sovereignty principles, Vitalik
Buterin's wallet/privacy writings, WalletBeat Stage 2 direction, and current
smart-account competitors.

## Executive Summary

Loom has a coherent contract posture for a self-sovereign wallet engine:
immutable account core, no factory or developer admin, ERC-4337 validation,
ERC-1271, delayed configuration, guardian-threshold recovery, guardian freeze,
vault withdrawal delays, granular sessions, L1-rooted keystore direction, and a
young SDK that requires explicit signer and bundler adapters. Evidence:
`LoomAccount` stores an immutable EntryPoint and mutable user-owned
configuration only (`src/account/LoomAccount.sol:98-104`), rejects unsupported
execution modes (`src/account/LoomAccount.sol:329-357`), requires delayed
module/config operations (`src/account/LoomAccount.sol:614-630`), and exposes
SDK send paths that fail without caller-supplied signer and transport
(`packages/sdk/src/index.js:195-213`).

Top five release-blocking gaps:

1. **No production L1 storage-proof verifier.** `LoomKeystore` stores L1 roots
   and versions (`src/keystore/LoomKeystore.sol:40-84`), but production release
   gates still require independent audit and per-network rehearsal for each
   storage proof verifier (`docs/security/production-readiness.md:126-128`).
   This blocks the cross-L2 keystore promise.
2. **Privacy is a safe boundary, not a live private-transfer product.**
   Metadata budgets, consent, and local scan state exist
   (`packages/privacy/src/index.js:132-273`, `packages/privacy/src/index.js:276-360`),
   and private vault builders bind operation and metadata hashes
   (`packages/account/src/index.js:237-258`). There is still no production
   Railgun, Privacy Pools, or Aztec adapter with relayer/prover/indexer failure
   evidence.
3. **WalletBeat Stage 2 cannot be earned by contracts alone.** The repository
   correctly states that the client must provide light-client verification,
   custom endpoints, force-withdrawal flows, simulation, clear signing,
   ERC-5792 reporting, FOSS release evidence, audits, and bounty
   (`docs/standards/walletbeat-stage-2.md:19-34`). These are not yet production
   artifacts.
4. **SDK is promising but not production-comparable yet.** The SDK has account
   deployment, call sending, recovery, migration, session, vault, passkey, and
   explicit bundler surfaces (`packages/sdk/src/index.js:127-313`), but lacks
   typed contract encoders, example apps, live bundler qualification evidence,
   WebAuthn browser-device fixtures, and production package release evidence
   (`docs/security/production-readiness.md:133-138`).
5. **Deployment evidence is still missing.** Production release requires
   bytecode hashes, salts, constructor args, explorer verification, chain
   EntryPoint/P-256 checks, and live rehearsal (`docs/security/production-readiness.md:168-176`).
   The repo has manifest requirements, but not signed production manifests.

## Vitalik-Aligned Findings

### Social Recovery And Graded Access

Vitalik's social recovery model uses a normal signing key plus guardian
majority key changes, with guardian/config changes delayed and high-value
actions protected by delay or threshold. Loom mostly matches this. Recovery
proposals require a complete old validator set, a new validator, a new guardian
root, guardian approvals, a 3-day delay, and a 7-day execution window
(`src/recovery/RecoveryManager.sol:66-128`). Execution rechecks delay, expiry,
config version, old validator hash, and init data hash before calling account
recovery (`src/recovery/RecoveryManager.sol:147-167`). The account also
supports complete validator-set replacement and guardian-root rotation
(`src/account/LoomAccount.sol:426-458`).

Gap: the deployment-time guardian ceremony is still not implemented in the
client/deployment tooling. The contracts can verify guardian commitments, but
they cannot prove that the user's offchain encrypted backup, proof of
possession, and guardian contact path are usable.

### Wallet Security And Privacy

Vitalik's 2024 wallet essay argues that wallet decentralization, censorship
resistance, security, and privacy matter only if the wallet itself preserves
them. Loom's core has strong unruggability: immutable shared implementation
proxy dispatch with no upgrade/admin selector, no factory-controlled ownership
path, timelocked high-risk changes, and no user/module delegatecall surface.
The account only accepts EntryPoint or self execution, validates direct
execution through installed validators and an expiry-bound EIP-712 digest, and
uses ordinary `call`, not user-requested delegatecall, for authorized
execution.

Privacy is correctly treated as a security property, but implementation remains
incomplete. The SDK refuses provider access until metadata budget and consent
checks pass (`packages/privacy/src/index.js:225-273`), but private transfer
execution needs concrete adapters and failure-mode tests before Loom can claim
live private payments.

### Cross-L2 Reading And L1 Keystore

Vitalik's cross-L2 reading proposal favors asset/keystore separation: a
keystore stores verification keys in one location and wallets on L1/L2 update
or read from it. Loom's `LoomKeystore` stores `validatorRoot`, `guardianRoot`,
`appAccountRoot`, `guardianThreshold`, and monotonic `version`
(`src/keystore/LoomKeystore.sol:40-84`). This matches the direction.

Gap: current implementation is a root registry plus proof-gated sync surface,
not a production verifier. Base, OP Stack, and Arbitrum assumptions still need
chain-specific proof specs, finality/reorg rules, storage slot derivation, and
testnet evidence.

### Cypherpunk / Walkaway Test

Loom's best current property is walkaway architecture. Users are not forced
through a company server, recovery provider, paymaster, or bundler in the core
contracts. The SDK also requires explicit signer and transport adapters before
broadcast (`packages/sdk/src/index.js:195-213`) and explicit bundler endpoints
(`packages/sdk/src/index.js:316-402`).

Gap: walkaway operation is not fully proven until there is public deployment
evidence, multiple independent bundler tests, reproducible manifests, light
client/read verification, and a non-Loom SDK example that can recover, migrate,
and exit.

## Engineering Process Findings

The repository is moving from prototype to production process. It now has
automated gates for tests, coverage, static analysis, fuzzing, invariants,
formal workflow, SDK tests, docs checks, and release gates
(`docs/security/production-readiness.md:6-84`). This fits an engineering model
of observe, measure, simplify, and introduce process when risk justifies it.

Strong practices already present:

- Explicit pre-audit status and no production-ready claim
  (`docs/security/production-readiness.md:1-4`).
- Clear separation between automated gates, audit-candidate gates, and security
  release gates (`docs/security/production-readiness.md:91-153`).
- Release gate requires clean reproducible build and compiler advisory review
  (`docs/security/production-readiness.md:74-77`, `docs/security/production-readiness.md:155-166`).

Engineering gaps:

- There is no checked-in production deployment manifest yet.
- The SDK has tests, but not a public example app or live integration matrix.
- Privacy adapter boundaries are tested conceptually, but not against real
  protocol dependencies.
- Competitive review must be refreshed after every major SDK/contract change;
  stale wording was already found and updated in `docs/project/ecosystem-review.md`.

## WalletBeat Stage Estimate

| Area | Current Estimate | Evidence | Minimum Change For Stage 2 Direction |
|---|---:|---|---|
| Account abstraction | Stage 2-ready contract base | ERC-4337 validation path in `src/account/LoomAccount.sol:236-264` | Live two-bundler testnet qualification and public evidence |
| Atomic batching | Strong contract support | Batch loop reverts atomically on subcall revert in `src/account/LoomAccount.sol:347-357` and `_execute` bubbles revert in `src/account/LoomAccount.sol:868-878` | ERC-5792 capability/reporting in client and vectors |
| Unruggability | Strong | Immutable proxy implementation pointer, no admin/upgrade selector, delayed module install, and no privileged factory path | Deployment manifests proving implementation/proxy/factory/registry code hashes and no upgrade authority |
| Portability | Partial | ERC-1271 in `src/account/LoomAccount.sol:266-275`; limited module profile documented in `docs/standards/walletbeat-stage-2.md:8-17` | More standard ERC-7579 adapters and independent client examples |
| Recovery | Strong contract base | Proposal/cancel/execute state machine in `src/recovery/RecoveryManager.sol:66-167` | Guardian ceremony tooling and real-device tests |
| Permissions | Good contract base | Granular scope fields in `src/validators/GranularSessionValidator.sol:20-33`; revoke/enumeration in `src/validators/GranularSessionValidator.sol:98-109` | ERC-7715/permission RPC translation and wallet UX evidence |
| Impact mitigation | Strong contract base | Vault policy/delay/cancel paths in `src/hooks/VaultHook.sol:77-146`; guardian freeze in `src/account/LoomAccount.sol:574-608` | Live token portfolio rehearsal and monitoring evidence |
| Verified wallet | Roadmap only | Client requirements listed in `docs/standards/walletbeat-stage-2.md:19-34` | Light-client backed reads and degraded-mode UX |
| Privacy | Boundary only | Consent/metadata checks in `packages/privacy/src/index.js:132-273` | Real privacy protocol adapter and local scanning |
| Governance/release maturity | Pre-audit | Pre-audit status in `docs/security/production-readiness.md:1-4` | Audit, bug bounty, signed reproducible release |

## Competitive Diff

| System | What They Have | Loom Advantage | Loom Gap |
|---|---|---|---|
| Safe | Mature SDK packages for Protocol Kit, API Kit, Relay Kit, and ERC-4337/token-fee support in Safe Core SDK public docs | Loom has no Safe transaction service dependency and avoids broad module/admin authority | Safe has much deeper tooling, audits, deployments, and ecosystem integrations |
| Argent | Guarded, recoverable, lockable, and upgradable smart-contract wallet model; historically strong social recovery and daily-limit UX | Loom avoids upgrade authority and company-operated recovery assumptions | Argent has mature mobile UX and battle-tested recovery flows |
| Soul Wallet | ERC-4337, modules/hooks, upgrade module, social recovery module, paymaster support | Loom deliberately avoids arbitrary upgrade/admin paths and narrows module authority | Soul's module ecosystem and stablecoin gas path are more mature |
| Biconomy Nexus | ERC-7579 account, extensive SDK, token gas, sponsored gas, batching, cross-chain orchestration | Loom is more self-sovereign and less infra-dependent by design | Biconomy has far better developer UX, live infra, and orchestration |
| ZeroDev | ERC-4337 and EIP-7702, passkeys/social login, recovery, sponsored/ERC20 gas, sessions, chain abstraction | Loom is less WaaS-like and requires explicit infrastructure choices | ZeroDev has mature SDKs, live networks, and adoption evidence |
| Alchemy Wallet APIs | `createSmartWalletClient`, EIP-7702 default, `sendCalls`, paymaster, signer support | Loom does not default to a provider or paymaster | Alchemy has much more polished quickstart and production infra |
| Ambire | Clear signing, account scoping, swap/simulation features, Safe previews, and rich transaction interpretation | Loom's contract base is more privacy/walkaway oriented | Loom lacks ABI decoder, simulation UX, typed preview, and app catalog layers |

## Prioritized Remediation Backlog

### P0: Production L1 Keystore Verifier

- Define L1 storage proof verifier interface for Base, OP Stack, and Arbitrum
  without L1-L2 messaging assumptions.
- Add finality delay, reorg behavior, storage slot derivation, and chain
  manifest specs.
- Add negative tests for stale root, wrong account, wrong storage slot, wrong
  version, and verifier replay.
- Require independent audit before production use.

### P0: Live Wallet Engine Qualification

- Run account deploy, batch, session grant/revoke, recovery proposal/cancel,
  migration, and vault withdrawal against at least two independent bundlers.
- Publish per-chain EntryPoint, P-256 precompile/fallback, factory/module
  bytecode, constructor args, salts, and explorer verification.
- Add non-Loom publisher path evidence for walkaway execution.

### P0: Privacy Adapter Production Slice

- Implement one real adapter behind the existing privacy boundary first.
- Require local scan state, metadata budget review, relayer/prover/indexer
  failure handling, vault interaction rehearsal, and native exit fallback.
- Keep private protocol dependencies outside the account core.

### P1: SDK Developer Experience

- Add typed encoders for account, recovery, migration, vault, session, and
  paymaster policy calls.
- Add a minimal reference app and integration examples that do not hardcode a
  Loom-operated RPC, bundler, paymaster, or recovery service.
- Add viem-compatible transports/signers where possible without making a
  default provider call.

### P1: WebAuthn And Guardian Ceremony

- Add browser-generated fixtures for Chrome, Firefox, Safari, YubiKey, Android
  passkey, Apple passkey, and Windows Hello.
- Add guardian tree construction, proof-of-possession, encrypted backup, and
  deployment-time usability proof tooling.
- Document which guardian verifier types are production-ready and which are
  experimental.

### P1: WalletBeat Stage 2 Client Evidence

- Implement ERC-5792 capability/reporting in the client layer.
- Add transaction simulation, calldata interpretation, clear signing, and ABI
  decoder integration.
- Add verified reads for balance, nonce, recovery, guardian root, vault, and
  keystore state.

## Proposed GitHub Issues

1. `feat(keystore): implement production L1 storage proof verifier profile`
2. `test(integration): qualify account lifecycle across two independent bundlers`
3. `feat(privacy): implement first production private-transfer adapter`
4. `feat(sdk): add typed lifecycle encoders and viem-compatible adapters`
5. `test(webauthn): add browser and hardware-authenticator fixture corpus`
6. `feat(guardians): add deployment-time guardian ceremony tooling`
7. `docs(ops): publish deployment manifest and reproducibility evidence format`
8. `feat(client): add ERC-5792 capability reporting and clear-signing preview`

## Ambiguous Items Requiring Tests

- Whether direct execution should be enabled by default for all validators:
  test with policy hooks, freeze, replay, and expiry under two signer types.
- Whether the current limited ERC-7579 profile is enough for third-party module
  builders: run conformance vectors and at least one adapter PoC.
- Whether private vault withdrawals can be made user-safe with one protocol
  first: run failure drills for stale scan state, relayer refusal, prover
  failure, and indexer inconsistency.
