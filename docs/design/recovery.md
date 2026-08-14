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

## Optional approval publication

`proposeRecovery` takes the complete threshold approval array in one call, so
guardians must in effect approve simultaneously and every response has to reach
one coordinating device. A guardian also has no way to learn that an account
they protect is being recovered.

`RecoveryIntentBoard` is an optional, immutable, ownerless contract that closes
that gap without becoming a second authority. It has no storage variables and
is never installed as a module, so `recoverConfiguration` is unreachable from
it and there is no state for a griefer to grow.

- `announce(...)` emits an intent and writes nothing. Anyone may call it and it
  is unverified by construction. It cannot occupy a recovery slot, reset a
  delay, cancel, block a request, or make the account pay, because those live
  in `pendingRecoveries` on a manager it cannot write to. Announcing is
  optional per recovery and clients must not do it silently.
- `publishApproval(...)` reads `configVersion` from the account and the
  recovery nonce from the manager, takes its digest from
  `RecoveryManager.proposalDigest`, and verifies exactly one guardian through
  `GuardianVerificationLib.approved` at threshold one. A caller who is not a
  guardian under the live root cannot emit it.

Both entry points require the named manager to be the recovery module the
account itself installed. The caller supplies that address, so without the check
the digest would come from a contract of the caller's choosing; and because the
published identity is derived from the advertised parameters rather than from
the manager -- it has to stay byte-identical to `RecoveryManager.recoveryIdFor`
-- a post could otherwise carry the identity of a genuine recovery while its
approval was verified against a digest nobody with authority ever defined. An
account holds at most one recovery module, so there is exactly one answer.

Reassembly happens off-chain and `RecoveryManager` is unchanged: it still
re-verifies every approval before accepting a proposal. Clients must treat a
board log as a hint worth verifying, never as evidence. The board is not bound
into the approval signature, so an approval published on one board is equally
valid off-chain, on another board, or assembled by hand — and a deployment that
omits the board simply has no on-chain discovery.

Publishing has a privacy cost that private sharing does not. A guardian's
verifier, commitment, salt, proof, and signature normally become public only
when `proposeRecovery` succeeds, and the guardian root rotates in the same
transaction, so disclosure is atomic with retirement. A guardian who publishes
early and then sees the recovery abandoned or cancelled has revealed themselves
against a root that is still live, and nothing rotates to repair it. Clients
must keep private sharing the default and present publication as an explicit,
warned choice. Recorded in
`docs/decisions/0024-recovery-intent-board.md`.

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
