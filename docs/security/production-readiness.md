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
- 10,000-run fuzz tests and 1,000-run stateful invariants.
- Paymaster selection forwarding and permission-bound paymaster regression tests.
- Granular session target, selector, token, counterparty, amount, batch,
  timing, use-limit, enumeration, and revocation tests.
- Multi-passkey credential uniqueness, threshold, ordering, lifecycle, shared
  WebAuthn verification, and ERC-1271 rejection tests.
- Recovery proposal visibility, delay, expiry, account/guardian cancellation,
  frozen cancellation, stale-config invalidation, replay protection, and
  atomic complete-validator-set plus guardian-root replacement tests.
- Official EntryPoint counterfactual single, atomic batch, and sponsored
  paymaster validation/post-operation lifecycle tests.
- Provider-independent direct execution replay, expiry, policy, freeze, hook,
  configuration-invalidation, validator nonce isolation, rollback, P-256/MFA,
  and atomicity tests.
- Sovereign migration delay, destination code/config binding, call commitment,
  optional codehash-only destination binding, guardian-threshold cancellation,
  expiry, cancellation, freeze behavior, hook enforcement, atomic rollback, and
  stale-config invalidation tests.
- Halmos symbolic property workflow for core authority invariants.
- Guardian freeze cannot be cleared early by a compromised primary validator,
  and guardians have no general UserOperation or ERC-1271 authority.
- Coverage report generation.
- Source scan confirming excluded cryptography is absent.
- Reproducible build from a clean checkout with pinned dependencies.
- Solidity compiler version must not be affected by a published
  security-relevant compiler bug under the repository's optimizer, IR, and EVM
  settings.

Coverage gates exclude symbolic formal harnesses because Halmos, not Forge
coverage, executes them. The current unfiltered report excluding formal
harnesses is approximately 86.4% lines and 60.5% branches. `LoomAccount`
coverage is approximately 86.8% lines and 59.6% branches. `RecoveryManager`
coverage is approximately 97.7% lines and 75.0% branches. Before audit freeze,
every security-critical production module should reach at least 80% lines and
60% branches and the production-source target must become an enforced CI
gate.

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
