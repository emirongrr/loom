# Production Readiness Gates

Loom remains pre-audit. Passing repository checks is necessary but
does not make a deployment production-ready.

## Automated release gates

- Formatting and zero-warning Solidity lint.
- Pinned Slither static analysis with high-severity findings failing CI.
- Production-contract size checks that exclude test/formal harnesses and
  deployment scripts.
- Checked-in deterministic unit/integration gas snapshot regression check with
  a 1% tolerance for environment-level measurement noise. Stateful invariants
  run separately because their randomized call distribution is not a stable
  gas benchmark.
- Unit and official EntryPoint v0.9 integration tests.
- 2,048-run fuzz tests and 256-run/depth-50 stateful invariants on every pull
  request (`FOUNDRY_PROFILE=ci`). Nightly verification raises this to
  20,000-run fuzz and 2,000-run/depth-100 stateful invariants
  (`FOUNDRY_PROFILE=deep`); a release should not be tagged on a commit that
  has not also passed at least one nightly `deep`-profile run.
- Paymaster selection forwarding and permission-bound paymaster regression tests.
- Granular session target, selector, token, counterparty, amount, batch,
  timing, use-limit, enumeration, and revocation tests.
- Multi-passkey credential uniqueness, threshold, ordering, lifecycle, shared
  WebAuthn verification, and ERC-1271 rejection tests.
- Recovery proposal visibility, delay, expiry, account/guardian cancellation,
  frozen cancellation, stale-config invalidation, replay protection, and
  atomic complete-validator-set plus guardian-root replacement tests.
- Guardian verifier tests for ECDSA, WebAuthn P-256, ERC-1271 contract
  wallets, malformed commitments, verifier reverts, and non-contract signer
  rejection.
- Official EntryPoint counterfactual single, atomic batch, and sponsored
  paymaster validation/post-operation lifecycle tests.
- Provider-independent direct execution replay, expiry, policy, freeze, hook,
  configuration-invalidation, validator nonce isolation, rollback, P-256/MFA,
  and atomicity tests.
- EIP-7702 delegated initialization tests proving external initialization
  rejection, self-only initialization, constructor-account reinitialization
  rejection, template EntryPoint binding, and post-initialization execution.
- Sovereign migration delay, destination code/config binding, call commitment,
  optional codehash-only destination binding, guardian-threshold cancellation,
  expiry, cancellation, freeze behavior, hook enforcement, atomic rollback, and
  stale-config invalidation tests.
- Vault daily spending, delayed exact withdrawal, native ETH path,
  guardian-threshold cancellation, duplicate-guardian rejection, expiry,
  stale-config invalidation, and revert rollback tests.
- L1 keystore registration, controller-only updates, proof-gated sync,
  app-account membership, stale L1 version rejection, local config
  invalidation, guardian cancellation, delay, expiry, and complete-validator-set
  replacement tests.
- Keystore proof profile tests for every production-candidate verifier,
  including Ethereum L1 direct-read, OP Stack, or Arbitrum profile evidence,
  immutable verifier bytecode, storage-slot derivation, finality assumptions,
  negative vectors, and explicit rejection of messaging, bridge, oracle, or
  Loom-service authority.
- Privacy adapter permission-binding, metadata-budget, local-scanning,
  relayer/indexer/prover degraded-mode, vault interaction, cancellation,
  expiry, and native-exit fallback tests before any concrete adapter is
  accepted.
- Privacy adapter profile tests for every production-candidate Railgun,
  privacy-pool, or Aztec adapter, proving pinned dependency review, no default
  provider, explicit consent, no viewing-key or account-graph disclosure,
  local-first scan state, fail-closed stale scan behavior, optional relayer,
  vault delay for protected unshield flows, native exit fallback, and no
  account authority granted to the privacy protocol.
- Wallet engine SDK tests for no default provider side effects, app-scoped
  session binding, explicit bundler transport, gas estimation, receipt polling,
  passkey signer challenge binding, middleware mutation, private-vault binding,
  and no broadcast without caller-supplied signer and transport.
- Kohaku provider-profile tests for user RPC, local node, Helios-verified RPC,
  Colibri-compatible provider, unavailable provider, stale indexer sync,
  locally persisted sync state, and no pre-consent default RPC queries.
- Hybrid account-security tests proving two-signature ERC-4337 verification,
  ECDSA compatibility, post-quantum signature failure rejection, no
  single-signature fallback, delayed migration, guardian cancellation, native
  exit fallback, and destination codehash binding before any Kohaku account
  profile is accepted.
- Halmos symbolic property workflow for core authority invariants.
- Guardian freeze cannot be cleared early by a compromised primary validator,
  and guardians have no general UserOperation or ERC-1271 authority.
- Enforced aggregate production-source coverage gate with at least 80% line
  coverage and 60% branch coverage across `src/**`, plus the same per-module
  gate for security-critical account, factory, adapter, hook, keystore,
  recovery, session, and validator contracts. The gate also reports named
  account-core, recovery, vault, and session risk groups so audit reviewers can
  see which authority boundary is under-covered.
- Source scan confirming experimental account cryptography is absent from
  production contract scope unless an explicit audit-candidate decision has
  moved it into scope.
- Source scan confirming no SDK package (`packages/account`, `packages/guardian`,
  `packages/privacy`, `packages/sdk`) hardcodes an RPC endpoint or known
  provider hostname as a default, consistent with the no-default-provider
  design principle.
- Reproducible build from a clean checkout with pinned dependencies.
- Solidity compiler version must not be affected by a published
  security-relevant compiler bug under the repository's optimizer, IR, and EVM
  settings.

Coverage gates exclude symbolic formal harnesses because Halmos, not Forge
coverage, executes them. The current unfiltered report excluding formal
harnesses is approximately 91.4% lines and 64.4% branches across production
source. CI enforces both the aggregate production-source gate and per-module
80% line / 60% branch gates for the security-critical production modules
listed in `tools/check-coverage-gate.mjs`, plus named risk-group coverage for
account-core, recovery, vault, and session authority.

Slither's `arbitrary-send-eth` warning is locally suppressed only on the
account execution call because arbitrary authorized execution is the core
smart-account capability. The detector remains enabled everywhere else.
Remaining static-analysis warnings are tracked in `docs/security/static-analysis.md`.

## Audit-candidate gates

- Pass every contract-review question in `docs/project/principles.md`; any
  permanent provider veto or undocumented service dependency blocks release.
- Resolve the P0 interoperability and authentication/recovery gaps tracked in
  `docs/project/ecosystem-review.md`.
- Reach and enforce the production-source branch coverage target.
- Add browser-generated WebAuthn fixtures from each supported browser and
  platform combination.
- Complete an internal line-by-line review against `docs/security/audit-scope.md`.
- Freeze the audit source revision and publish its build, test, coverage,
  static-analysis, and bytecode artifacts.
- Resolve or explicitly accept every item in the preliminary review and
  static-analysis triage.
- Resolve or explicitly accept every release-blocking residual risk in
  `docs/security/assumptions-and-risks.md`.

## Security release gates

- Independent audit covering account core, validators, hooks, factory, and
  deployment configuration.
- Dedicated review of WebAuthn client-data compatibility, duplicate-field
  rejection, hook denial-of-service behavior, and module initialization.
- All critical and high findings fixed and independently retested.
- Public testnet deployment with bundler interoperability tests.
- Optional token-fee paymaster interoperability tests proving native-gas
  fallback and rejection of unapproved paymasters.
- Live migration rehearsal between independently deployed source and
  destination accounts, including ERC-20 portfolios, guardian cancellation,
  cancellation, expiry, alternative EntryPoint destinations, codehash-only
  future-standard destinations, and permissionless execution through a non-Loom
  publisher.
- Live vault rehearsal across native ETH, canonical ERC-20s, non-standard
  ERC-20 behavior, guardian cancellation, monitoring notifications, and
  delayed private-withdrawal adapter assumptions.
- Independent audit and per-network testnet rehearsal for each production L1
  storage proof verifier used by keystore sync. Test-only verifier contracts
  are not acceptable for production. Each verifier must also publish a
  passing keystore proof profile under `docs/operations/keystore-proof-profile.md`.
- Verified wallet client release evidence showing light-client backed reads
  for balances, nonces, recovery state, guardian roots, vault state, validator
  state, and L1 keystore roots, plus explicit degraded-mode UX when a chain is
  only partially verified.
- SDK production release evidence showing browser WebAuthn implementation
  compatibility, ERC-4337 bundler interoperability across at least two
  independent operators, paymaster middleware isolation, receipt timeout
  behavior, account deployment rehearsal, recovery ceremony rehearsal, and
  developer documentation that states every required adapter and trust
  assumption.
- Privacy adapter release evidence for each supported protocol, including
  dependency and license review, protocol threat model, metadata-leakage
  review, local-first scanning, relayer/prover/indexer failure behavior,
  bridge or finality assumptions, vault interaction rehearsal, and clear user
  warnings for degraded modes. Each adapter must publish a passing privacy
  adapter profile under `docs/operations/privacy-adapter-profile.md`.
- Root, documentation-site, and Kohaku SDK dependency audits must pass at low
  severity or better. Any override used to keep audit clean must have a
  compatibility check, upstream-release review, exploitability analysis, and
  isolation test proving vulnerable behavior is unreachable from untrusted
  wallet input.
- Funded public bug bounty and private vulnerability reporting process. This
  is intentionally deferred until after audit and public-testnet hardening,
  but remains mandatory before production funds are accepted.
- Incident response, deployment verification, and rollback communication
  procedures. Immutable accounts cannot be upgraded after deployment.

## Advisory baseline

The repository pins Solidity `0.8.35`. Solidity `0.8.28` was removed because
the official compiler bug list marks it affected by high-severity
`SOL-2026-1` when using IR code generation on Cancun or later EVM versions.
Loom does not currently use transient storage, but audit candidates must not
remain on an affected compiler merely because the known trigger is absent.

OpenZeppelin Contracts is present only as a test-tool dependency in the
current source graph. EntryPoint `0.9.0` is used for interfaces and integration
tests; its maintainers publish no security advisories as of the review date.
Advisory status and dependency reachability must be rechecked at every release.

## Per-chain deployment gates

- Verify official EntryPoint v0.9 address and bytecode.
- Verify P-256 precompile behavior or fallback verifier bytecode.
- Verify explorer source, compiler, optimizer, constructor arguments, and
  deployment salt.
- Publish account, factory, module, and bytecode hashes.
- Exercise counterfactual deployment, validation, batching, freeze, recovery,
  allowance revoke, and policy limits on the target chain.
