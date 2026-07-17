# Architecture

## Principles

Loom accounts are deployed through an immutable shared implementation proxy to
reduce account creation cost. This is not an upgrade mechanism: each proxy
stores its implementation address as an immutable code value, has no admin or
upgrade selector, and cannot change implementation after deployment. New Loom
versions require a new implementation, a new factory, and explicit user
migration rather than an in-place proxy upgrade. There is no developer recovery
path or privileged factory operation. Every authority must be installed by the
account and exercised through an installed validator.

The account implements the ERC-4337 validation entry point, provider-independent
direct signed execution, ERC-1271 signature validation, and Loom-specific
single and atomic batch execution using the ERC-7579 mode-byte layout. Loom is
not a conformant ERC-7579 account: its
single-call encoding and module interfaces are intentionally narrower and are
not plug-and-play compatible with standard ERC-7579 modules. Only validator
and hook modules plus one narrowly scoped recovery module are supported.
Executor, fallback, and delegatecall execution modes are deliberately
rejected.

Two optional adapter directions bridge the standard without widening the core.
Outbound, `ERC7579ModuleAdapter` gives Loom-native modules the standard module
lifecycle. Inbound, `ERC7579ValidatorShim` and `ERC7579HookShim` (decision 0010)
let one foreign ERC-7579 validator or hook run on one account through a per-
account binding, translating Loom's narrower profile to and from the standard
surface. The shims are optional; the account runs identically without them and
never depends on them.

The core can receive ETH and accepts safe ERC-721 and ERC-1155 transfers
through stateless receiver callbacks. These callbacks do not grant execution
authority.

The same account runtime can also be used as an EIP-7702 delegation target for
EOAs that need to preserve an existing address. A delegated EOA must perform a
self-call to `initializeDelegatedAccount(...)` with an explicitly selected
EntryPoint before it has Loom authority. Constructor-deployed accounts cannot
use this initializer because their `configVersion` is already non-zero. EIP-7702
behavior is documented in `docs/design/eip-7702.md`.

The account also exposes a delayed sovereign migration state machine. A user
can schedule an exact atomic batch that moves assets or authority toward a
specific destination account after the configuration delay. The commitment binds
the destination address, destination runtime code hash, destination
`configHash` when available, call batch hash, current `configVersion`,
account-local migration nonce, and chain ID. Migration execution is
permissionless after the delay, but still passes through freeze checks, active
hooks, and policy accounting. The account can cancel the pending migration
through a self-call only while the account is not frozen; the guardian threshold
can cancel without receiving spending or execution authority.

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
- `ExactCallSessionValidator` grants revocable, time-bounded, use-limited permissions
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

Validation resource bounds are part of the supported authorization profile,
not merely client recommendations. `ValidationGasCeilingsTest` exercises the
declared maxima with the pinned compiler and EVM profile:

- WebAuthn accepts at most 1,024 bytes of authenticator data, 1,024 bytes of
  `clientDataJSON`, and 256 bytes of origin; the combined maximum-input
  validation path must remain below 1,500,000 gas.
- Guardian threshold verification accepts at most 32 sorted approvals and 32
  Merkle siblings per proof. The maximum-approval path and maximum-proof path
  must remain below 1,500,000 and 400,000 gas respectively.
- Recovery validator-set validation accepts at most 16 validators and its
  maximum replacement-set path must remain below 600,000 gas.

Inputs above these limits fail before cryptographic verification or the full
bounded loop. These ceilings are regression limits for supported validation
work; bundlers must still estimate the complete UserOperation rather than use
them as `verificationGasLimit` values.

`RecoveryManager` verifies guardian threshold signatures directly against the
account guardian root, records a visible pending recovery, enforces a
three-day delay and seven-day execution window, supports account or guardian
cancellation, and atomically replaces the complete committed validator set
and guardian root through the account's narrow recovery entry point. Guardian
leaves bind salted key commitments to immutable verifier code hashes. The
manager has no arbitrary execution authority. Loom includes guardian verifiers
for ECDSA address commitments, WebAuthn P-256 passkeys, and ERC-1271 contract
wallets such as multisigs.
Recovery behavior is documented in `docs/design/recovery.md`.

## Graded access

Primary validator `validateUserOp` checks the signature and that the configured
policy hook is still installed, but it does not ask `PolicyHook` whether the
call is low risk during ERC-4337 validation. This keeps validation narrow for
bundler compatibility. The installed hook enforces low-risk policy when the
account executes the call, and direct signed execution asks the same hook before
accepting the direct execution digest.

A policy is scoped to a target and selector, limits value per call and per
period, and may restrict the ERC-20 recipient or spender to one address. A zero
counterparty means unrestricted destination. Calls outside policy cannot
complete through normal account execution or direct execution.

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

## Vaults

Long-term storage is enforced through an optional hook, not through extra
account-core authority. `VaultHook` protects configured ERC-20 assets and
native ETH with a daily spending path plus an exact delayed withdrawal path.
Large withdrawals bind the target, value, calldata hash, current
`configVersion`, vault delay, expiry window, and the account's own scheduled
execution commitment. Guardian-threshold cancellation can clear a pending
withdrawal without granting guardians asset-transfer authority.

The initial hook deliberately understands only canonical token transfer,
transfer-from, approve, and native-value movement. Asset valuation, rebasing
tokens, bridge exits, private transfers, and DeFi position accounting require
separate audited modules or client-side construction.

Vault behavior is documented in `docs/design/vaults.md`.

## Cross-chain readiness

Every account exposes a locally maintained `configHash` and monotonically
increasing `configVersion`.

Loom now includes the first L1-rooted keystore surface:

- `LoomKeystore` stores canonical identity configuration on Ethereum L1.
- `KeystoreSyncRecoveryModule` can apply a newer L1 configuration to an L2
  account only through an audited proof verifier, app-account Merkle
  membership, a local delay, expiry, and stale-config invalidation.

The sync module is optional and recovery-scoped. It does not make a bridge,
oracle, relayer, RPC provider, or Loom service authoritative. A production
deployment must provide a real `IKeystoreProofVerifier` for the target network;
test-only verifier contracts do not belong to production source.

The design is documented in `docs/design/keystore.md`.

## SDK and tooling

Loom's off-chain code is a set of headless TypeScript packages, not a framework.
They build, explain, verify, and publish account operations; none becomes account
authority or a mandatory service, and an account stays operable if all of them
disappear. Per-package implementation status lives in `docs/status.md`; this
section fixes the boundaries that shape them.

The packages layer around one canonical core:

- `@loom/core` is the leaf: canonical types, ABIs, errors, encoding and hashing,
  contract and version metadata, and the single deployment-manifest schema. Every
  other package depends on it and on nothing else in the layer.
- `@loom/sdk` is the account client: counterfactual address derivation and the
  ERC-4337 v0.9 operation pipeline — initializer encoding, nonce, fees, gas, the
  canonical EntryPoint hash, the `(validator, validatorSignature)` envelope,
  simulation, send, and receipt. Passkey signatures are the on-chain
  `WebAuthnSignature` structure, never a bare hash.
- `@loom/passkey`, `@loom/guardian`, `@loom/deployment`, and `@loom/cli` are
  separate packages because each sits on a real platform, secret, Node-runtime,
  or signer boundary.
- `@loom/privacy` is optional and experimental and is never a dependency of
  `@loom/sdk` — the dependency points the other way: privacy layers on top of
  the wallet engine and is the canonical import point for the private-flow
  surface (`createKohakuRuntime`, `preparePrivateVaultWithdrawal`; the same
  names on `@loom/sdk` are deprecated for one cycle). A client constructed
  without a Kohaku host runs the entire non-private path; only touching the
  privacy runtime fails, at use, with a typed error. Privacy is reached only
  through a structural adapter, so a normal wallet install pulls in no Kohaku,
  Railgun, or privacy-pool code.

No package ships a default RPC, bundler, paymaster, or privacy provider:
transports are injected and provider replacement is a first-class path. Deployed
addresses are trusted only against the canonical manifest — the SDK refuses a
chain whose EntryPoint, proxy, implementation, or verifier code hash does not
match, unless the caller explicitly selects an unverified mode. The `loom` CLI is
a thin layer over these libraries: it never accepts a raw key as an argument and
supports machine-readable `--json` output with a stable exit-code contract.

`loom devnet` composes a reproducible local stack — anvil, the repo-pinned
contracts, and the Alto bundler, all versions fixed in `devnet/versions.json` —
and records what it started in `.loom/devnet/state.json`. Teardown, status, and
log commands act only on resources that state file names, so the CLI never kills
or inspects a process it did not start. The EntryPoint is CREATE2-deployed at a
version-prefixed address because bundlers infer the EntryPoint version from the
address prefix. This devnet is what proves the wallet engine's send pipeline
against a real bundler end to end (`tools/e2e/bundler-devnet.mjs`): account
creation uses the sovereign direct-to-EntryPoint path — the factory fail-closes
to the real SenderCreator, which no third-party simulator can satisfy — and all
later traffic runs as ordinary bundler operations.

Packages are TypeScript compiled to ESM with generated type declarations. `viem`
is used internally for ABI and ERC-4337 encoding, but never appears in a public
interface: those stay defined by Loom's own structural provider types.

The publishable surface is `@loom/core` and `@loom/sdk`. A single release packer
stages each package with the release version, rewrites the sdk's in-repo
`file:` dependency on core to that exact version, strips private and dev-only
fields, and stamps a stability label — the packages are pre-audit and say so in
their own metadata. The same packer feeds both the release workflow and the
clean-room example test, so the tarballs an install would pull are byte-for-byte
the ones proven to derive, deploy, and operate an account end to end. The
release attaches those tarballs with checksums and an integrity manifest and
runs a provenance-ready dry-run publish; the version is the git tag, so there is
no separately maintained version to drift.
