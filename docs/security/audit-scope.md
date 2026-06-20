# Audit Scope

Loom consists of immutable smart-account contracts deployed through a
non-upgradeable shared implementation proxy. The audit must evaluate the
complete interaction between the account core, proxy, registry, validators,
hooks, factory, and the official ERC-4337 v0.9 EntryPoint.

## In-scope production contracts

- `src/account/LoomAccount.sol`
- `src/account/LoomAccountFactory.sol`
- `src/proxy/LoomAccountProxy.sol`
- `src/factory/AppAccountRegistry.sol`
- `src/hooks/PolicyHook.sol`
- `src/hooks/VaultHook.sol`
- `src/keystore/EthereumL1KeystoreVerifier.sol`
- `src/keystore/LoomKeystore.sol`
- `src/recovery/RecoveryManager.sol`
- `src/recovery/KeystoreSyncRecoveryModule.sol`
- `src/recovery/ECDSAGuardianVerifier.sol`
- `src/validators/ECDSAValidator.sol`
- `src/validators/P256Validator.sol`
- `src/validators/MultiP256Validator.sol`
- `src/validators/SessionKeyValidator.sol`
- `src/validators/GranularSessionValidator.sol`
- All interfaces and libraries under `src/`
- Deployment scripts and constructor configuration under `script/`

Vendored dependencies are in scope where Loom relies on their behavior,
especially EntryPoint validation, nonce handling, and sender creation.

## Required security invariants

1. No Loom-controlled address, factory, deployer, or privileged administrator
   can execute from or reconfigure an account.
2. An account always retains at least one installed validator.
3. Configuration changes cannot execute before the required delay.
4. A config change invalidates operations committed to an older
   `configVersion`.
5. Unsupported execution modes and all user/module-requested delegatecall
   execution revert. The only delegatecall in production scope is the
   non-upgradeable proxy dispatch to its immutable implementation.
6. Batch execution is atomic.
7. Frozen accounts cannot perform normal execution.
8. A single guardian can freeze but cannot transfer assets.
9. Guardian thresholds cannot be satisfied by duplicate or invalid proofs.
10. Session permissions cannot authorize a different call, exceed their use
    count, or remain valid after revocation.
11. Policy spending cannot exceed per-call or per-period limits, including
    through reentrancy or a reverting inner call.
12. A broken hook can delay normal execution but cannot permanently prevent
    its own delayed removal.
13. Primary validators cannot authorize arbitrary ERC-1271 messages.
14. Account deployment addresses are deterministic and factory deployment
    cannot introduce authority.
15. Duplicate credential identifiers or duplicate public keys cannot satisfy
    a multi-passkey threshold.
16. Multi-passkey credential and threshold changes cannot bypass the
    configuration timelock.
17. Recovery cannot execute before its delay, after expiry, after
   cancellation, after configuration changes, or more than once.
18. Only an installed recovery module can use the narrow complete-validator-set
   plus guardian-root replacement entry point, and recovery cannot grant
   arbitrary execution authority.
19. Recovery rejects partial, duplicate, unsorted, or stale validator sets.
20. Guardian approvals are unique, committed to verifier code hash, and cannot
   use an uncommitted signer or verifier.
21. Scheduled execution cannot bypass an active policy, except that the exact
   delayed removal of an installed hook bypasses hooks for liveness.
22. A hook-set change during scheduled lifecycle execution cannot alter the
    pre-check/post-check hook snapshot.
23. Direct execution cannot replay, use an uninstalled or non-direct validator,
    bypass validator policy, bypass freeze, bypass hooks, or survive expiry or
    a configuration change.
24. Direct nonces are isolated per validator and rejected or reverting direct
    executions cannot consume a nonce.
25. Sovereign migration cannot execute before its delay, after expiry, after
    cancellation, after source configuration changes, or against a destination
    whose code hash or `configHash` differs from the committed values.
26. Sovereign migration executes only the exact committed atomic batch, remains
    blocked while frozen, and cannot bypass installed hooks or policy
    accounting.
27. Failed or reverting migration execution preserves the pending migration and
    cannot consume the migration nonce.
28. Guardian-threshold migration cancellation cannot execute calls, cannot move
    assets, rejects duplicate or invalid guardian approvals, and consumes the
    migration nonce only on success.
29. Vault daily spending cannot exceed configured per-period limits and must
    roll back when the protected inner execution reverts.
30. Vault withdrawals above the daily limit require the exact pending
    withdrawal, account scheduled operation, vault delay, current
    `configVersion`, and unexpired execution window.
31. Guardian-threshold vault cancellation cannot execute calls, cannot move
    assets, and rejects duplicate, missing, stale, or invalid guardian
    approvals.
32. L1 keystore updates cannot be made by non-controllers and versions must
    advance monotonically.
33. Keystore sync cannot apply without a valid proof verifier response,
    app-account membership, newer L1 version, complete old validator set,
    local delay, unexpired window, and unchanged local `configVersion`.
34. Keystore sync cancellation cannot execute calls, cannot move assets, and
    rejects duplicate or invalid guardian approvals.
35. A proxy account's implementation address cannot change after deployment,
    has no admin or upgrade selector, and stores account state in the proxy
    rather than in the shared implementation.
36. The app registry is analytics-only: only its immutable factory can
    register accounts, duplicate registration cannot inflate `accountCount`,
    and registry membership grants no execution, recovery, or migration
    authority.

## Reviewer focus areas

- Hook bypass recognition for delayed removal of an installed hook.
- Scheduled operation identity and invalidation across config changes.
- External module initialization and de-initialization calls.
- Hook ordering, revert behavior, and spending-accounting rollback.
- Hook snapshot behavior when a scheduled lifecycle operation changes the
  installed hook set between pre-check and post-check.
- WebAuthn client-data canonicalization, origin binding, flags, and signature
  malleability checks.
- Multi-passkey credential uniqueness, ordering, threshold bounds, and
  lifecycle behavior.
- Guardian Merkle proofs, signature ordering, domains, and config-version
  binding.
- Recovery proposal identity, cancellation, expiry, replay protection,
  validator replacement, and recovery-module authority.
- ERC-4337 validation behavior, malformed signatures, prefunding, and nonce
  semantics.
- Proxy initialization, immutable implementation dispatch, revert bubbling,
  storage separation from the implementation, and absence of upgrade/admin
  selectors.
- App registry factory-only registration, duplicate handling, and its
  non-authority relationship to account execution.
- Direct-execution domain separation, nonce/config invalidation, explicit
  validator capability, and hook behavior when the caller is an arbitrary
  transaction publisher rather than the EntryPoint.
- Sovereign migration identity, cancellation, expiry, source-config
  invalidation, destination binding, hook enforcement, and atomic rollback.
- Codehash-only migration destinations for future account standards, including
  the weaker assurance compared with Loom `configHash` binding.
- Vault policy lifecycle, exact withdrawal identity, guardian cancellation,
  expiry, config-version invalidation, and rollback after reverting protected
  calls.
- L1 keystore controller authority, identity registration, config versioning,
  app-account root binding, proof-verifier boundary, stale L1 version
  rejection, sync cancellation, expiry, and local config invalidation.
- Non-standard ERC-20 return values and policy calldata parsing.

## Out of scope

- Wallet user interface and transaction interpretation.
- Bundler, paymaster, RPC provider, and chain infrastructure implementations.
- Private transfer systems.
- Concrete production L1 storage proof verifier implementations until they are
  added to audit scope.

These components may affect the safety of a future wallet but do not belong to
this contracts-only repository.

## Audit build

The audit commit must be frozen before review. Record the commit hash, compiler
version, optimizer settings, dependency revisions, bytecode hashes, full test
output, gas snapshot, coverage summary, and static-analysis output.
