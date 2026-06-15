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
| Session validators | Approve bounded calls | Permission parser or nonce-key mistake | Exact bounds, immediate revoke, dedicated nonce key |
| Factory and deployment | Select immutable account inputs | Wrong EntryPoint, module, guardian root, or verifier | Reproducible manifests and independent verification |
| Wallet client | Constructs and explains authority | Clear-signing failure, metadata leakage, unsafe defaults | Open-source independent clients and the walkaway test |

## Contract limitations

- The account permanently binds one EntryPoint for ERC-4337. Direct signed
  execution preserves provider-independent publication. Immediate direct
  execution remains policy-limited; arbitrary high-risk calls retain their
  visible delay. The migration state machine provides delayed account exit but
  does not change the EntryPoint for the source account.
- Installed validators, hooks, recovery modules, and guardian verifiers are
  trusted code selected by the user. Timelocks make changes visible; they do
  not make malicious code safe.
- Guardian commitments hide initial addresses, but a guardian reveals its
  verifier, commitment, salt, proof, and signature when acting. Successful
  recovery atomically rotates to a fresh root; freeze does not.
- One valid guardian can intentionally freeze ordinary execution for 48 hours.
- Token limits constrain canonical calldata amounts. They do not model
  fee-on-transfer behavior, rebasing, callbacks, token valuation, bridge
  semantics, or malicious token implementations.
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
6. Guardian-tree construction, proof-of-possession, encrypted backup, and
   verifier deployment correctness remain client/deployment responsibilities.

## Cypherpunk acceptance rule

No mitigation may add a Loom administrator, mandatory registry, privileged
relayer, upgrade key, hidden recovery provider, or permanent provider veto.
When safety and convenience conflict, prefer the narrow, independently
executable path and document its limitations truthfully.
