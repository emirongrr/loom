# Security Assumptions And Residual Risks

Loom is an immutable authorization system, not a guarantee that every
installed module, chain, token, client, or external service behaves correctly.
Security claims are valid only under the assumptions listed here and in
`docs/security/threat-model.md`.

## Authority surfaces

| Surface | Authority | Primary failure mode | Required control |
|---|---|---|---|
| EntryPoint | Calls ERC-4337 validation and account execution | ERC-4337 path loss or malicious official deployment | Per-chain bytecode verification, independent bundlers, direct signed execution, exact migration path |
| Validators | Approve UserOperations within their profile | Key compromise or validator implementation bug | Timelocked lifecycle, narrow validators, complete-set recovery |
| Hooks | Inspect and block execution | Policy bypass or temporary denial of service | Hook snapshot semantics, fail-closed behavior, exact delayed-removal bypass |
| Recovery module | Replaces the complete validator set | Guardian compromise or verifier bug | Threshold, visible delay, cancellation, expiry, immutable verifier code |
| Account proxy | Dispatches account calls to a shared implementation | Initialization bug, storage-layout mismatch, implementation-code dependency, mistaken upgrade assumption | Immutable implementation pointer, no admin or upgrade selector, one-time initialization, codehash manifests, proxy-specific tests |
| Single guardian freeze | Blocks ordinary execution for 48 hours | Repeated temporary denial after configuration changes | Independent guardians, visible freeze, no transfer authority |
| Scheduled execution | Executes an exact public commitment after delay | User signs a dangerous delayed call; public executor front-runs timing | Exact call commitment, config-version invalidation, installed hooks |
| Sovereign migration | Executes an exact delayed exit batch to a committed destination | Wrong destination, stale source config, hook bypass, failed asset move, public timing metadata | Destination code hash, optional config binding, calls hash, config-version invalidation, non-frozen account cancellation or guardian-threshold cancellation, expiry, atomic batch, installed hooks |
| Vault hook | Separates daily spending from delayed long-term storage withdrawals | Misconfigured policy, non-standard token semantics, public withdrawal metadata | Exact withdrawal commitments, account delay plus vault delay, guardian-threshold cancellation, config-version invalidation |
| L1 keystore | Stores canonical cross-chain identity roots | L1 controller compromise, identity correlation, unsupported proof system | User-controlled L1 controller, monotonic versioning, app-account root, proof-gated delayed L2 sync |
| Keystore proof verifier | Authenticates keystore state for same-chain L1 sync or future L2 proof-pull sync | Verifier bug, stale or forged state-root assumptions, chain-specific finality mismatch | Immutable verifier binding, independent verifier audit, per-network deployment gates, disabled-by-absence production posture |
| Privacy adapters | Build private receive, transfer, shielded-pool, or private-execution flows | Account graph leakage, relayer/indexer/prover dependency, hardcoded RPC leakage, wrong bridge/finality assumption, false privacy claim, legally sensitive protocol exposure | Kohaku SDK stack, local-first scanning, provider profiles, metadata budgets, protocol-specific threat models, native exit fallback, adapter-specific release gates |
| Kohaku account-security tooling | Provides a future hybrid two-signature ERC-4337 account compatibility or migration target through the SDK stack | Unaudited verifier import, excessive gas, large public keys, wrong migration destination, hidden account replacement, single-signature fallback by mistake | Source-level tracking only, no core import, delayed migration, guardian cancellation, independent audit gate, explicit hybrid verification tests |
| Session validators | Approve bounded calls | Permission parser or nonce-key mistake | Exact bounds, immediate revoke, dedicated nonce key |
| Factory and deployment | Select immutable account inputs and implementation | Wrong EntryPoint, account implementation, module, guardian root, or verifier | Reproducible manifests, implementation codehash verification, deterministic address checks, independent verification |
| App registry | Records accounts deployed by one app factory for analytics | Account correlation, count inflation, mistaken authority source | Per-app registry, factory-only registration, duplicate rejection, no execution dependency, clear privacy documentation |
| EIP-7702 delegation | Lets an EOA preserve its address while using Loom runtime code | Malicious persistent delegation, wrong template, uninitialized delegated storage, cross-chain authorization blast radius | Self-only one-time initialization, template bytecode verification, chain-specific authorization, explicit client warnings |
| Wallet client | Constructs and explains authority | Clear-signing failure, metadata leakage, unsafe defaults | Open-source independent clients and the walkaway test |
| Verified wallet client | Displays and constructs operations from chain state | False balances, stale nonces, hidden recovery, wrong roots, account graph leakage | Light-client verification, explicit unknown states, user-selected endpoints, privacy-preserving scanning |

## Contract limitations

- Proxy-deployed accounts rely on the selected shared implementation code
  continuing to exist and match the deployment manifest. The proxy cannot
  change implementation, so a flawed implementation requires explicit user
  migration to a new account rather than an upgrade transaction.
- The proxy uses `delegatecall` only for fixed implementation dispatch. Loom
  still rejects user/module-requested delegatecall execution modes. Storage
  layout changes in future implementations must be treated as new-account
  migration work, not as in-place upgrade work.
- The app registry is not an account authority source. It can support app-local
  account counts and public TVL indexing, but registry membership does not
  prove user consent, wallet installation, ownership, or private balances.
- The account permanently binds one EntryPoint for ERC-4337. Direct signed
  execution preserves provider-independent publication. Immediate direct
  execution remains policy-limited; arbitrary high-risk calls retain their
  visible delay. The migration state machine provides delayed account exit but
  does not change the EntryPoint for the source account.
- EIP-7702 delegated accounts write the selected EntryPoint during self-only
  initialization. Selecting the wrong runtime or initializer EntryPoint is
  equivalent to selecting the wrong account implementation for that EOA.
- EIP-7702 authorization is persistent and can be phished. Loom contracts can
  require self-only initialization and normal account policy after setup, but
  they cannot make a user-signed delegation to malicious code safe.
- Installed validators, hooks, recovery modules, and guardian verifiers are
  trusted code selected by the user. Timelocks make changes visible; they do
  not make malicious code safe.
- Guardian commitments hide initial addresses, but a guardian reveals its
  verifier, commitment, salt, proof, and signature when acting. Successful
  recovery atomically rotates to a fresh root; freeze does not.
- Passkey and ERC-1271 guardian verifiers expand signer choice, but each
  configured guardian remains trusted to sign only after authentic user intent.
  Safe, Loom, institutional, HSM, or other ERC-1271 guardians inherit their own
  threshold, policy, hardware, custody, and operational risks.
- One valid guardian can intentionally freeze ordinary execution for 48 hours.
  During that window, the primary validator cannot self-cancel scheduled calls
  or migrations; guardian-threshold cancellation remains available for the
  flows that explicitly support it.
- Token limits constrain canonical calldata amounts. They do not model
  fee-on-transfer behavior, rebasing, callbacks, token valuation, bridge
  semantics, or malicious token implementations.
- Vault policy currently protects native ETH and canonical ERC-20 transfer,
  transfer-from, and approve calldata. It does not understand LP tokens,
  bridge receipts, private-note systems, ERC-4626 shares, lending positions,
  or arbitrary DeFi accounting.
- Privacy adapters are not core account security. A Railgun, Aztec, stealth
  address, or privacy-pool adapter can improve confidentiality only under its
  own protocol, relayer, prover, bridge, scanner, and metadata assumptions.
  Adapter failure must not prevent ordinary account control, recovery,
  migration, or native-gas operation.
- Kohaku provider selection is privacy-sensitive. A wallet must not silently
  query a hardcoded RPC, default indexer, or relayer before the user has a
  configured provider profile or a clearly labeled degraded mode.
- Kohaku SDK dependencies rely on local npm overrides for `ws` and
  `underscore` to avoid known transitive advisories through `ethers`, `viem`,
  `jsonpath`, and `bfj`. These are client/SDK supply-chain controls, not
  LoomAccount bytecode controls. Production SDK release still requires
  re-running audit, checking upstream package releases, and proving the
  overrides remain compatible with the Kohaku packages in use.
- Kohaku account-security tooling is not currently Loom account logic. It is
  tracked as SDK stack capability and future migration target. Importing its
  verifier contracts into production scope requires a separate decision record,
  independent audit, gas review, deployment verification, and tests proving
  delayed migration, guardian cancellation, native exit fallback, and
  two-signature verification semantics.
- Large vault withdrawals require two visible delays when scheduled through
  the account: the account's configuration delay for creating the pending
  withdrawal, then the vault withdrawal delay for executing the protected
  movement.
- Policy periods depend on chain timestamps and configured token selectors.
- Hook recovery intentionally bypasses hooks only for the exact delayed
  removal of an already-installed hook.
- Contracts cannot provide transaction interpretation, private RPC access,
  private transfers, chain verification, force withdrawals, or censorship-
  resistant publication UX by themselves.
- Verified wallet state is a client responsibility. Until a light-client based
  wallet exists, UI state can still depend on RPC correctness even when account
  authority does not.
- Migration cannot guarantee that every asset has a safe or standard transfer
  interface. A migration batch is atomic, but users and clients must still
  construct asset-specific calls correctly.
- Codehash-only migration destinations are supported for future account
  standards and EntryPoint transitions, but they provide weaker assurance than
  Loom destinations with a non-zero `configHash` commitment.
- L1 keystore sync is only as strong as the L1 controller and the installed
  proof verifier. A test verifier is not production infrastructure.
- The repository implements a same-chain Ethereum L1 direct verifier that reads
  `LoomKeystore` directly and rejects proof bytes. It does not prove L1 state
  to Base, Optimism, Arbitrum, or any other L2.
- The repository does not yet implement production L2 storage proof verifiers.
  A production L2 verifier must specify its trusted L1 state root source,
  finality delay, reorg handling, storage-slot derivation, account-proof
  validation, and chain-specific failure behavior.
- Keystore sync maps `validatorRoot` to a complete replacement validator set
  and initialization payloads. The set must be sorted, duplicate-free, and
  applied atomically after the sync delay. This improves cross-chain validator
  portability but does not remove the need for audited production L2 proof
  verifiers.
- Keystore sync does not prove privacy of account membership. `appAccountRoot`
  hides enumeration but an app account reveals membership when it presents a
  proof, and reuse of one identity across many public accounts can still create
  correlation.
- `appAccountRoot` reduces public enumeration but does not by itself hide all
  cross-chain identity correlation if users reuse one identity across many
  public app accounts.

## Release-blocking residual risks

1. No independent audit has reviewed the current immutable bytecode.
2. Full live lifecycle evidence against two independent ERC-4337 bundlers is
   missing.
3. Browser-generated and physical-device WebAuthn fixtures are missing.
4. Formal proofs cover selected safety properties, not full functional
   correctness, liveness, cryptography, compiler correctness, or every
   external-contract behavior.
5. Sovereign migration is implemented but unaudited and has no live migration
   rehearsal across deployed accounts, token portfolios, independent
   publishers, alternative EntryPoints, and codehash-only future-standard
   destinations.
6. Vault policy is implemented but unaudited and has no live rehearsal against
   production token portfolios, bridge assets, private withdrawal adapters, or
   guardian-monitoring tools.
7. Vault policy does not yet include asset-specific adapters for ERC-4626
   vaults, bridge receipts, LP positions, privacy pools, or private withdrawal
   protocols.
8. L1 keystore sync is implemented at the registry/module boundary and has a
   same-chain Ethereum L1 verifier, but lacks production L2 storage proof
   verifiers for Base, Arbitrum, Optimism, and future supported rollups.
9. Keystore sync supports complete multi-validator root application, but has no
   live cross-chain rehearsal proving L1 update, proof
   generation, L2 proposal, cancellation, expiry, and execution on each target
   rollup.
10. Keystore identity creation still requires a client-side ceremony that
   prevents identity squatting, stores encrypted recovery material, and lets
   users choose separate identities for privacy-sensitive contexts.
11. Guardian-tree construction, proof-of-possession, encrypted backup, and
    verifier deployment correctness remain client/deployment responsibilities.
12. zkEmail guardian recovery is not production-supported until a concrete
    circuit, verifier, DKIM/root trust model, nullifier policy, replay rules,
    and independent audit are selected and documented.
13. Verified wallet client implementation is missing. Production UX must not
    claim RPC-independent balances, nonces, recovery state, guardian roots,
    vault state, validator state, or cross-chain identity state until those
    reads are verified or clearly labeled unverified.
14. Privacy adapter implementation is limited to the generic SDK boundary.
    Railgun and Aztec production profiles still require protocol-specific SDK
    review, metadata-leakage analysis, local scanning evidence,
    permission-binding tests, vault interaction tests, bridge/finality
    assumptions, and independent audit before production use.
15. Kohaku account-security tooling is source-tracked but not production
    integrated. Production use requires reviewed verifier contracts, migration
    rehearsals, dependency review, updated audit scope, and tests proving the
    ECDSA-compatible signature path and post-quantum signature path are both
    required where the account profile claims hybrid security.
16. Kohaku SDK dependency graph currently passes npm audit only with pinned
    local overrides for vulnerable transitive packages. Production SDK release
    must revalidate those overrides against upstream Kohaku releases and keep
    isolation tests for untrusted wallet input and network-facing runtime
    paths.
17. Immutable proxy deployment is implemented but unaudited. Production release
    requires independent review of proxy initialization, storage layout,
    implementation codehash binding, registry non-authority, deployment
    manifests, gas tradeoffs, and migration guidance.

## Cypherpunk acceptance rule

No mitigation may add a Loom administrator, mandatory registry, privileged
relayer, upgrade key, hidden recovery provider, or permanent provider veto.
When safety and convenience conflict, prefer the narrow, independently
executable path and document its limitations truthfully.
