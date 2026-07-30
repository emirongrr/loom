# Visible Delayed Recovery

`RecoveryManager` restores access by atomically replacing the complete
committed validator set with one new validator and rotating to a fresh guardian
root after a visible delay. It never receives arbitrary execution, executor,
delegatecall, token-transfer, or upgrade authority.

Accounts may be created in an explicit guardianless bootstrap state with
`guardianRoot == 0` and `guardianThreshold == 0`. This state improves passkey
onboarding but does not provide social recovery, guardian freeze, or
guardian-threshold cancellation. Wallets and SDKs must describe it as
unprotected recovery. Users can add a real guardian root later through the
normal delayed self-configuration path.

`@loom/guardian` provides a progressive setup planner for this path. The
planner verifies redacted guardian onboarding evidence, builds the
`setGuardianConfig(root, threshold)` calldata, and wraps it in the account's
delayed `scheduleCall(...)` self-call. It does not choose guardians, publish a
guardian graph, bypass the three-day config delay, or add any Loom-operated
recovery service.

## Lifecycle

1. The user creates a new validator or passkey configuration on a new device.
   This step needs a *deployed validator instance the account does not already
   have installed*, because recovery replaces the whole validator set and both
   `proposeRecovery` and `recoverConfiguration` reject an already-installed
   `newValidator`. Loom's validators are multi-tenant, so recovering to a new
   credential of the same kind cannot reuse the installed instance.

   `LoomValidatorFactory` provisions it without a privileged party.
   `predict(account, recoveryNonce, creationCodeHash)` gives the address offline,
   before it exists, so the guardians in step 2 can commit to it; `deploy(...)` is
   permissionless and idempotent, so the user, a guardian, a relayer, or a
   stranger may publish it, and racing parties converge on the same instance.
   The deployer gains nothing: the factory never initializes the instance, and
   validator state is keyed by the calling account, which binds it during step 5.

   Binding the recovery nonce into the salt gives every recovery a distinct
   instance, so a later recovery is never blocked by the already-installed rule.
2. The guardian threshold signs a recovery-specific EIP-712 proposal binding
   the account, complete old-validator-set hash, new validator,
   initialization-data hash, fresh guardian root and threshold,
   `configVersion`, recovery nonce, chain, and recovery-manager address.
3. Anyone submits the proposal. The complete pending state and timestamps are
   visible on-chain.
4. A three-day delay begins. The existing account authority or the guardian
   threshold may cancel during this period.
5. After the delay, anyone may execute the exact committed complete-set
   replacement and guardian rotation during a seven-day execution window.
Partial and duplicate validator sets, zero guardian roots, invalid
thresholds, and reuse of the old guardian root are rejected.
6. Execution advances `configVersion` and the recovery nonce. Replays and
   proposals committed to stale configuration fail.

Only one pending recovery and one installed recovery module are allowed per
account. Recovery cancellation remains available while the account is frozen,
but only for the exact installed-module call targeting the account itself.

## Guardian authority

The manager verifies sorted, duplicate-free guardian approvals directly
against the account's guardian Merkle root and threshold. Guardian leaves bind
a salted key commitment, verifier address, and verifier code hash. This avoids
publishing guardian addresses in the initial configuration and keeps signer
verification outside the account core without introducing a registry.

The included ECDSA, WebAuthn P-256, and ERC-1271 verifiers commit to address,
passkey, and contract-wallet guardians without publishing their key material
until use. An acting guardian necessarily reveals its verifier, commitment,
salt, Merkle proof, and signature. Recovery therefore requires a fresh guardian
root and atomically invalidates the revealed old tree. Other verifier
implementations require independent review and a timelocked guardian-root
change. Proxy or mutable verifier implementations are not acceptable
production guardians. Guardian verifier classes are documented in
`docs/design/guardians.md`.

The constructor cannot prove that an opaque Merkle root contains enough live,
independent guardians without revealing them or verifying a dedicated
zero-knowledge proof. Production setup must perform an off-chain
proof-of-possession ceremony, independently rebuild the root, retain encrypted
recovery material, and simulate the exact recovery proposal before funding the
account. A future zero-knowledge setup proof requires separate design and
audit; Loom will not claim that an arbitrary root is usable.

For guardianless accounts, the same ceremony must happen before the user signs
the delayed setup plan. Until that scheduled call executes on-chain, the
account remains unprotected and clients must continue showing recovery as
unavailable.

Once a non-zero guardian configuration is installed, the account does not allow
it to be cleared back to zero. A user who intentionally wants a guardianless
account again should migrate to a new account under the visible migration
rules instead of silently deleting recovery from the current account.

## Industry examples

- Safe Modules includes a dedicated Recovery Module. Loom follows the
  dedicated-module concept but does not grant the module general Safe-style
  execution authority.
- Argent contracts popularized guardians combined with a security period and
  cancellation window. Loom similarly makes recovery delayed and observable.
- Rhinestone ModuleKit includes scheduling primitives and social-recovery
  module patterns. Loom keeps a narrower immutable-account recovery surface
  instead of enabling general executors.

References:

- https://github.com/safe-fndn/safe-modules
- https://github.com/argentlabs/argent-contracts
- https://github.com/rhinestonewtf/modulekit

These references are design examples, not claims of identical behavior or
audit equivalence.
