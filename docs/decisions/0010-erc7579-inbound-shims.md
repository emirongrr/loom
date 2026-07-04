# Decision 0010: ERC-7579 Inbound Module Shims

## Status

Accepted.

## Context

Loom is deliberately not a conformant ERC-7579 account (decision context in
`docs/design/architecture.md`): it hands validators and hooks a narrower,
deconstructed profile rather than the full `PackedUserOperation`/`(msgSender,
msgValue, msgData)` surface, and it rejects executor and fallback modules and
delegatecall execution. The existing `ERC7579ModuleAdapter` covers the
*outbound* direction — it gives Loom-native modules the standard
`onInstall`/`onUninstall`/`isModuleType`/`isInitialized` lifecycle so 7579
tooling can install them.

The enterprise-platform goal wants the *inbound* direction: let an institution
reuse an existing, audited third-party ERC-7579 validator or hook (Rhinestone,
ZeroDev, Safe7579, etc.) on a Loom account without forking Loom. The
architecture review found Loom already supports this with no core change,
provided a translation layer bridges the interface mismatch. This record decides
that layer.

The layer touches new external code paths in the validation and hook slots, so
it crosses the change threshold and gets a decision record and a threat-model
update before implementation.

## Decision

Add two inbound adapter contracts in `src/adapters/`, one per supported module
type, alongside the existing outbound adapter:

- `ERC7579ValidatorShim` implements `ILoomValidator` and forwards to a foreign
  `IERC7579Validator`.
- `ERC7579HookShim` implements `ILoomHook` and forwards to a foreign
  `IERC7579Hook`.

Each shim binds one `(account, target)` pair immutably and holds no mutable
state. The 1:1 binding is a correctness requirement, not a convenience: a
standard ERC-7579 module keys its per-account state by `msg.sender`, and from
the target's view `msg.sender` is always the shim. A shim shared across accounts
would collapse every account onto a single target-side identity and corrupt that
state. One shim per account makes the shim a faithful, unique stand-in for its
account in both the lifecycle calls and validation/hook calls.

Lifecycle (`onInstall`/`onUninstall`) is callable only by the bound account and
mirrors `ERC7579ModuleAdapter`'s account-state assertions (installed before
`onInstall`, cleared before `onUninstall`), then forwards to the target. Shims
are deployed permissionlessly: anyone can construct one binding their account to
a target, then install it through the account's ordinary timelocked
`installModule` path.

### Interface reconstruction and its honest boundary

`ERC7579ValidatorShim` rebuilds a `PackedUserOperation` from Loom's profile with
`sender = account`, and the real `nonce`, `callData`, and `signature`. It zeroes
`initCode`, `accountGasLimits`, `preVerificationGas`, and `gasFees`, and sets
`paymasterAndData` to the 20-byte paymaster address only. The `userOpHash` is
passed through unchanged. Validators that read gas fields, `initCode`, or
paymaster data beyond the address are therefore **not supported** through the
shim. Signature-based validators — the common case — are.

`ERC7579HookShim` maps Loom's `preCheck(account, caller, accountCall)` to the
standard `preCheck(msgSender = caller, msgValue = 0, msgData = accountCall)` and
targets the single-argument `postCheck(hookData)` form. `msgValue` is zero
because Loom's hook callback does not carry the top-level call value;
per-execution values live inside `accountCall`. Hooks that gate on top-level
`msgValue` are not supported.

### Non-goals

- No executor shim and no fallback shim: those module types and delegatecall
  remain rejected by the Loom core, and the adapter must not reopen them.
- No module registry or attestation dependency: Rhinestone's registry and any
  attestation scheme remain optional client-side tooling, never an on-chain
  trust anchor in the account path.

## Consequences

Positive:

- Institutions reuse audited third-party validators/hooks on Loom accounts with
  no core change and no fork.
- The Loom core, its authority model, and its narrow profile are untouched; the
  shims are optional and Loom runs identically without them.
- A future standard gets its own shim pair the same way, without a core change.

Risks:

- A foreign module is external code running in a validation or hook slot. It is
  exactly as trusted as any validator or hook the account installs, and it
  enters only through the same timelocked `installModule` path with the same
  guardian-eviction and scheduled-removal escape hatches. Installing a
  malfunctioning foreign hook can make hook availability part of account
  availability until the delayed removal clears, identical to a native hook.
- The reconstruction boundary is silent: a validator that depends on zeroed
  fields will simply fail validation (fail-closed), not corrupt state, but the
  failure is not self-describing. Integrators must check module compatibility
  against the documented boundary.
- Correct state isolation depends on the 1:1 binding. Installing one shim on the
  wrong account is prevented by the bound-account checks; sharing a target across
  accounts is safe only because each account gets its own shim.
- The foreign target may be stateful, and it treats `msg.sender == shim` as the
  account's authority. The shim therefore gates `validateUserOp` (and lifecycle)
  to the bound account: without that gate, any third party could mutate
  target-side state (usage counters, replay markers) in the account's name.
  Loom's native validators do not need this gate because their `validateUserOp`
  is `view`.
- ERC-4337 simulation rules: during EntryPoint validation the target reads
  storage keyed by the shim's address, which is not storage associated with the
  userOp sender. Under the canonical unstaked-entity rules, bundlers may reject
  such operations unless the relevant entity is staked or the bundler relaxes
  the rule. This is a bundler-acceptance/liveness concern, not a safety one, and
  it does not affect `executeDirect`, which bypasses bundlers entirely.
  Deployments relying on shimmed validators for 4337 flows must rehearse against
  their target bundlers.

Required controls:

- Conformance tests must drive a realistic foreign validator (ownable-style,
  keyed by `msg.sender`) and a foreign hook through a real `LoomAccount`,
  proving install/validate/ERC-1271/uninstall and the reconstruction of
  `userOp.sender`, plus rejection of foreign callers, unbound accounts, and
  wrong-type targets. (`test/ERC7579InboundShims.t.sol`.)
- The compatibility boundary (unsupported gas/initCode/paymaster/`msgValue`
  reads, no executor/fallback) must be documented in the shim NatSpec and the
  threat model.
- Post-audit, third-party module conformance vectors should be widened to real
  published modules in fork tests (tracked separately).

## Rejected Alternatives

- Make Loom a conformant ERC-7579 account: rejected. It would widen the
  execution surface (executor, fallback, delegatecall) and the validator profile
  that Loom deliberately narrows, weakening the core's auditability and
  authority guarantees for a portability feature that a thin adapter already
  delivers.
- One shared shim per module type (not per account): rejected. Standard modules
  key state by `msg.sender`, so a shared shim collapses all accounts onto one
  target-side identity and corrupts per-account state.
- `delegatecall` into the foreign module to preserve `msg.sender = account`:
  rejected. It runs untrusted module code in the account's storage context,
  which is exactly the delegatecall authority Loom forbids.
- Executor and fallback shims: rejected, consistent with the core's rejection of
  those module types and delegatecall.
