# Implementation Status

This file is the public truth table for the repository. It exists to keep the
README, docs site, and design documents aligned with the code.

Status labels:

- **Implemented:** production source exists and is covered by repository tests.
- **Partially implemented:** source exists, but release-critical evidence,
  integration, or deployment support is incomplete.
- **Boundary implemented:** the SDK or contract boundary exists, but concrete
  protocol integration remains future work.
- **Planned:** design direction exists, but the feature is not implemented.
- **Not implemented yet:** no working implementation is present in this
  repository.

## Feature Truth Table

| Feature | Evidence in repository | Status | Notes |
| --- | --- | --- | --- |
| Immutable smart account runtime | `src/LoomAccount.sol`, `test/unit/LoomAccount.t.sol`, `test/integration/EntryPointIntegration.t.sol` | Implemented | No account admin, factory authority, or proxy upgrade selector. |
| Immutable proxy factory | `src/LoomAccountFactory.sol`, `src/LoomAccountProxy.sol`, `test/integration/ImmutableProxyFactory.t.sol` | Implemented | Proxy stores an immutable implementation pointer; migration is explicit. |
| ERC-4337 validation | `src/LoomAccount.sol`, `lib/account-abstraction/`, `test/integration/EntryPointIntegration.t.sol` | Implemented | Repository targets EntryPoint v0.9 integration tests. |
| Direct signed execution | `src/LoomAccount.sol`, direct-capable validators, `test/unit/LoomAccount.t.sol` | Implemented | Intended as the provider-independent publication path for supported validators. |
| ERC-1271 signature checks | `src/LoomAccount.sol`, validators, tests under `test/` | Implemented | Policy-aware validators reject arbitrary hash signing where they cannot classify risk. |
| WebAuthn/P-256 validator | `src/validators/P256Validator.sol`, `src/libraries/WebAuthnP256.sol`, `test/unit/P256Validator.t.sol` | Implemented | Browser/device fixture coverage remains a production gate. |
| Multi-passkey MFA | `src/validators/MultiP256Validator.sol`, `test/unit/MultiP256Validator.t.sol` | Implemented | Enforces sorted unique credentials and threshold validation. |
| ECDSA validator | `src/validators/ECDSAValidator.sol`, `test/unit/LoomAccount.t.sol` | Implemented | Used for testing, migration, and hardware-wallet integration paths; not the preferred primary profile. |
| Exact-call sessions | `src/validators/ExactCallSessionValidator.sol`, `test/unit/LoomAccount.t.sol` | Implemented | Grants are bounded by exact call commitment, expiry, use count, and paymaster. |
| Granular sessions | `src/validators/GranularSessionValidator.sol`, `test/unit/GranularSessionValidator.t.sol` | Implemented | Covers target, selector, token, counterparty, amounts, time, use count, and paymaster. |
| Policy hook | `src/hooks/PolicyHook.sol`, `test/unit/PolicyHook.t.sol`, `test/regression/MaliciousHookTests.t.sol` | Implemented | Hook callbacks fail closed; hook removal has a narrow delayed recovery path. |
| Vault hook | `src/hooks/VaultHook.sol`, `test/unit/VaultHook.t.sol`, `test/formal/LoomVaultHookFormal.t.sol` | Implemented | Covers native ETH and canonical ERC-20 movement; richer assets need separate adapters. |
| Guardian recovery | `src/recovery/RecoveryManager.sol`, guardian verifiers, `test/integration/RecoveryManager.t.sol` | Implemented | Threshold, visible delay, expiry, cancellation, freeze, and validator-set replacement. |
| Guardian verifier types | `src/recovery/ECDSAGuardianVerifier.sol`, `src/recovery/P256GuardianVerifier.sol`, `src/recovery/ERC1271GuardianVerifier.sol`, `test/unit/GuardianVerifier.t.sol` | Implemented | Production guardian setup still depends on client/deployment ceremony. |
| Sovereign migration | `src/LoomAccount.sol`, `test/integration/SovereignMigration.t.sol`, `docs/design/lifecycle.md` | Implemented | Local-chain migration, not cross-chain sync. |
| EIP-7702 delegated account initialization | `src/LoomAccount.sol`, `test/integration/EIP7702Integration.t.sol`, `docs/design/eip-7702.md` | Implemented | Requires self-only initialization by the delegated EOA. |
| Limited ERC-7579 profile | `src/adapters/`, `test/integration/ERC7579LimitedProfile.t.sol`, `test/integration/ERC7579InboundShims.t.sol` | Partially implemented | Narrow adapter/shim surface only; Loom is not a full ERC-7579 account. |
| L1 keystore registry | `src/keystore/LoomKeystore.sol`, `test/integration/KeystoreSync.t.sol` | Implemented | Stores canonical identity configuration on L1. |
| Same-chain Ethereum L1 keystore verifier | `src/keystore/EthereumL1KeystoreVerifier.sol`, `test/unit/EthereumL1KeystoreVerifier.t.sol` | Implemented | Direct same-chain read; not an L2 proof verifier. |
| OP Stack L2 keystore verifier | `src/keystore/OPStackL2KeystoreVerifier.sol`, `test/unit/OPStackL2KeystoreVerifier.t.sol` | Partially implemented | Source and tests exist; production deployment requires audit, profile evidence, and live rehearsal. |
| Keystore sync recovery module | `src/recovery/KeystoreSyncRecoveryModule.sol`, `test/integration/KeystoreSync.t.sol` | Partially implemented | Proof-gated sync boundary exists; production L2 verifier evidence remains a release gate. |
| App account registry | `src/AppAccountRegistry.sol`, `docs/decisions/0009-app-account-registry.md` | Implemented | Registry is analytics/discovery support, not account authority. |
| SDK account builders | `packages/account/`, `test/integration/SdkCalldataDifferential.t.sol` | Implemented | Local lifecycle builders; no default network side effects. |
| Guardian SDK tooling | `packages/guardian/` | Implemented | Off-chain Merkle tree, setup, possession, and backup ceremony helpers. |
| Privacy SDK boundary | `packages/privacy/`, `docs/design/privacy-adapters.md` | Boundary implemented | Provider profiles, consent, metadata budgets, and adapter boundary exist; no production privacy claim. |
| Wallet engine SDK | `packages/sdk/` | Boundary implemented | Local client surface with explicit transports and adapters; not a finished wallet app. |
| Production wallet client | `examples/mobile-privacy-wallet/`, `docs/design/verified-wallet.md`, `docs/project/roadmap.md` | Boundary implemented | Mobile boilerplate exists with fail-closed gates; store-ready native passkeys, verified reads, live deployment, and privacy evidence remain release work. |
| Light-client verified wallet state | `docs/design/verified-wallet.md` | Planned | Contracts expose state, but no wallet light client is implemented here. |
| Production private transfers | `docs/design/privacy-adapters.md`, `docs/operations/privacy-adapter-profile.md` | Not implemented yet | Railgun, Aztec, privacy-pool, and stealth-address production flows require separate review and rehearsal. |
| Formal verification | `formal/`, `test/formal/`, `docs/security/formal-verification.md` | Partially implemented | Selected properties and program structure exist; not a proof of full correctness. |
| Independent audit | `docs/security/audit-scope.md`, `docs/security/production-readiness.md` | Not implemented yet | Repository is pre-audit. |

## Known Gaps

- The repository is pre-audit and must not secure production assets.
- The current source includes a mobile boilerplate, not a production-ready
  wallet application.
- Privacy adapters define boundaries and SDK scaffolding, not production
  private-transfer support.
- Light-client verified wallet state is specified, not implemented.
- Production L2 keystore verifier deployments need independent audit,
  per-network profile evidence, and live rehearsal.
- Browser-generated and physical-device WebAuthn fixtures remain release gates.
- Live multi-bundler qualification and public deployment evidence remain
  release gates.

## Documentation Boundary

If a feature is described in a design document but does not appear in this table
as implemented or partially implemented, treat it as design direction or future
work. Code and tests are the source of truth for implementation claims.
