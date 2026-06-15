# Architecture

## Principles

Loom accounts are immutable per-account contracts. There is no implementation
proxy, admin key, developer recovery path, or privileged factory operation.
Every authority must be installed by the account and exercised through an
installed validator.

The account implements the ERC-4337 validation entry point, provider-independent
direct signed execution, ERC-1271 signature validation, and Loom-specific
single and atomic batch execution using the ERC-7579 mode-byte layout. Loom is
not a conformant ERC-7579 account: its
single-call encoding and module interfaces are intentionally narrower and are
not plug-and-play compatible with standard ERC-7579 modules. Only validator
and hook modules plus one narrowly scoped recovery module are supported.
Executor, fallback, and delegatecall execution modes are deliberately
rejected.

The core can receive ETH and accepts safe ERC-721 and ERC-1155 transfers
through stateless receiver callbacks. These callbacks do not grant execution
authority.

The account also exposes a delayed sovereign migration state machine. A user
can schedule an exact atomic batch that moves assets or authority toward a
specific destination account after the configuration delay. The commitment binds
the destination address, destination runtime code hash, destination
`configHash`, call batch hash, current `configVersion`, account-local migration
nonce, and chain ID. Migration execution is permissionless after the delay, but
still passes through freeze checks, active hooks, and policy accounting. The
account can cancel the pending migration through a self-call, including while
frozen.

## Authorization

UserOperation signatures encode `(validator, validatorSignature)`. The account
will invoke the validator only when it is installed.

- `P256Validator` verifies WebAuthn relying-party binding, user-presence,
  user-verification, canonical same-origin `clientDataJSON`, base64url
  challenge binding, and low-s P-256 signatures. It is intended as the primary
  UserOperation validator.
- `MultiP256Validator` applies the same WebAuthn checks to up to 16 independent
  credentials and requires a configurable threshold of sorted, unique
  credential signatures. Credential identity and public-key fingerprints are
  both unique. Credential and threshold changes are timelocked.
- `SessionKeyValidator` grants revocable, time-bounded, use-limited permissions
  bound to an exact account call commitment and an explicitly selected
  paymaster. The zero address means the session must use native account-funded
  gas. Grants require the 72-hour config timelock; revocation remains
  immediate. Its permission ID and use count are enforced through ERC-4337's
  two-dimensional nonce.
- `GranularSessionValidator` grants reusable permissions bound to an exact
  target and selector, optional canonical ERC-20 token and counterparty,
  per-call and per-UserOperation amount limits, time range, call count, use
  count, and one explicitly selected paymaster. Every item in an atomic batch
  must satisfy the same permission. Grants are timelocked and revocation is
  immediate.
- `ECDSAValidator` exists for testing, migration, and hardware-wallet
  integrations. It is not the preferred primary validator.

`P256Validator`, `MultiP256Validator`, and `ECDSAValidator` explicitly support
direct signed execution for EntryPoint-independent publication. Direct calls
remain limited by the validator's low-risk policy, current configuration,
expiry, freeze state, installed hooks, and account-wide replay nonce. Session
validators do not receive this authority.

Primary and session validators reject arbitrary ERC-1271 hashes because a hash
alone cannot be classified by the policy hook. This prevents Permit-style
authorization from bypassing graded access.

The two session profiles and their deliberate limits are documented in
`docs/design/permissions.md`.
Multiple passkey and MFA behavior is documented in `docs/design/authentication.md`.

`RecoveryManager` verifies guardian threshold signatures directly against the
account guardian root, records a visible pending recovery, enforces a
three-day delay and seven-day execution window, supports account or guardian
cancellation, and atomically replaces the complete committed validator set
and guardian root through the account's narrow recovery entry point. Guardian
leaves bind salted key commitments to immutable verifier code hashes. The
manager has no arbitrary execution authority.
Recovery behavior is documented in `docs/design/recovery.md`.

## Graded access

The primary validator asks `PolicyHook` whether a call is low risk. A policy is
scoped to a target and selector, limits value per call and per period, and may
restrict the ERC-20 recipient or spender to one address. A zero counterparty
means unrestricted destination. Calls outside policy cannot be authorized by
the primary validator.

Policy limits are enforced by the hook for normal and scheduled execution.
They are absolute guardrails until removed through the config timelock, not
limits that a delayed call can silently bypass.

Hook callbacks fail closed. To prevent a reverting hook from permanently
bricking an account, the account recognizes exactly one hook-bypass recovery
shape: scheduling the 72-hour delayed removal of an already-installed hook.
The removal itself remains timelocked and every other execution still invokes
the pre-check snapshot of installed hooks.

High-risk calls use the account timelock or the visible delayed recovery state
machine. Non-config calls require at least 24 hours; account, validator, hook,
and recovery-module configuration calls require at least 72 hours. Scheduled
calls are public to execute after their delay and can be cancelled before
execution. Guardians never receive general UserOperation or ERC-1271
authority.

Sovereign migration is treated as a high-risk delayed account action, not as an
upgrade path. It does not grant Loom, a factory, or a module registry any
authority over the source account. It also does not implement cross-chain
configuration synchronization: each chain remains locally configured until a
separate trustless proof protocol is specified and audited.

## Cross-chain readiness

Every account exposes a locally maintained `configHash` and monotonically
increasing `configVersion`. The current account uses local configuration and exposes no remote
configuration application path. A future trustless synchronization mechanism
requires a separately audited protocol.
