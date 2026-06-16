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
| Single guardian freeze | Blocks ordinary execution for 48 hours | Repeated temporary denial after configuration changes | Independent guardians, visible freeze, no transfer authority |
| Scheduled execution | Executes an exact public commitment after delay | User signs a dangerous delayed call; public executor front-runs timing | Exact call commitment, config-version invalidation, installed hooks |
| Sovereign migration | Executes an exact delayed exit batch to a committed destination | Wrong destination, stale source config, hook bypass, failed asset move, public timing metadata | Destination code hash, optional config binding, calls hash, config-version invalidation, account or guardian-threshold cancellation, expiry, atomic batch, installed hooks |
| Vault hook | Separates daily spending from delayed long-term storage withdrawals | Misconfigured policy, non-standard token semantics, public withdrawal metadata | Exact withdrawal commitments, account delay plus vault delay, guardian-threshold cancellation, config-version invalidation |
| L1 keystore | Stores canonical cross-chain identity roots | L1 controller compromise, identity correlation, unsupported proof system | User-controlled L1 controller, monotonic versioning, app-account root, proof-gated delayed L2 sync |
| Keystore proof verifier | Authenticates L1 keystore state on another chain | Verifier bug, stale or forged state-root assumptions, chain-specific finality mismatch | Independent verifier audit, per-network deployment gates, disabled-by-absence production posture |
| Session validators | Approve bounded calls | Permission parser or nonce-key mistake | Exact bounds, immediate revoke, dedicated nonce key |
| Factory and deployment | Select immutable account inputs | Wrong EntryPoint, module, guardian root, or verifier | Reproducible manifests and independent verification |
| EIP-7702 delegation | Lets an EOA preserve its address while using Loom runtime code | Malicious persistent delegation, wrong template, uninitialized delegated storage, cross-chain authorization blast radius | Self-only one-time initialization, template bytecode verification, chain-specific authorization, explicit client warnings |
| Wallet client | Constructs and explains authority | Clear-signing failure, metadata leakage, unsafe defaults | Open-source independent clients and the walkaway test |

## Contract limitations

- The account permanently binds one EntryPoint for ERC-4337. Direct signed
  execution preserves provider-independent publication. Immediate direct
  execution remains policy-limited; arbitrary high-risk calls retain their
  visible delay. The migration state machine provides delayed account exit but
  does not change the EntryPoint for the source account.
- EIP-7702 delegated accounts inherit the EntryPoint immutable embedded in the
  delegated Loom template. Selecting the wrong template is equivalent to
  selecting the wrong account implementation for that EOA.
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
- Token limits constrain canonical calldata amounts. They do not model
  fee-on-transfer behavior, rebasing, callbacks, token valuation, bridge
  semantics, or malicious token implementations.
- Vault policy currently protects native ETH and canonical ERC-20 transfer,
  transfer-from, and approve calldata. It does not understand LP tokens,
  bridge receipts, private-note systems, ERC-4626 shares, lending positions,
  or arbitrary DeFi accounting.
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
- Migration cannot guarantee that every asset has a safe or standard transfer
  interface. A migration batch is atomic, but users and clients must still
  construct asset-specific calls correctly.
- Codehash-only migration destinations are supported for future account
  standards and EntryPoint transitions, but they provide weaker assurance than
  Loom destinations with a non-zero `configHash` commitment.
- L1 keystore sync is only as strong as the L1 controller and the target
  network's proof verifier. A test verifier is not production infrastructure.
- The repository defines `IKeystoreProofVerifier` but does not yet implement a
  production Ethereum L1 storage proof verifier. A production verifier must
  specify its trusted L1 state root source, finality delay, reorg handling,
  storage-slot derivation, account-proof validation, and chain-specific failure
  behavior.
- Keystore sync currently maps `validatorRoot` to one replacement validator and
  initialization payload. This matches the current account recovery entry point
  but does not yet support applying an arbitrary multi-validator root from L1.
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
8. L1 keystore sync is implemented at the registry/module boundary but lacks a
   production L1 storage proof verifier for Base, Arbitrum, Optimism, Scroll,
   and future rollups.
9. Keystore sync has no live cross-chain rehearsal proving L1 update, proof
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

## Cypherpunk acceptance rule

No mitigation may add a Loom administrator, mandatory registry, privileged
relayer, upgrade key, hidden recovery provider, or permanent provider veto.
When safety and convenience conflict, prefer the narrow, independently
executable path and document its limitations truthfully.
