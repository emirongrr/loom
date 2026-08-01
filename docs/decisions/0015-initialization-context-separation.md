# Initialization context separation

Status: accepted
Date: 2026-07-30

## Problem

`LoomAccount` carried two initializers on one runtime. `initializeDelegatedAccount`
required `msg.sender == address(this)`, but `initialize` had no caller check at
all: its only guard was the one-shot `configVersion != 0` test inside
`_initialize`.

An EIP-7702 delegated EOA executes the Loom runtime against its own, empty
storage, so before self-initialization it reads `configVersion == 0`. Any third
party could therefore call `initialize` on it and install an attacker-chosen
EntryPoint, validator set, hooks, guardian root, guardian threshold, and config
hash, then drain the account through `executeDirect`. Because `_initialize`
writes `configVersion = 1`, the owner's later `initializeDelegatedAccount`
reverted permanently and every recovery path keyed off the attacker's guardian
root: the takeover was unrecoverable.

ADR 0001 deliberately separates delegation from initialization because EIP-7702
does not run initcode, so the authorization and the self-initialization are two
transactions. That gap is publicly observable, which makes the attack a
straightforward front-run rather than a race the owner can win by being careful.

## Evidence

`initialize` cannot simply be made self-only. `LoomAccountProxy` delegatecalls it
from its own constructor, so `msg.sender` is the factory, and
`LoomAccountFactory` encodes that call as the proxy's `initData`. Changing the
initializer's name or signature would change `initData` and therefore every
counterfactual account address.

Neither the tests nor the formal specs could observe the vulnerable state. The
7702 integration test exercised only the `initializeDelegatedAccount` selector
against an external caller. Both
`check_InitializedAccountCannotBeReinitialized` and the Certora rule
`initializedAccountCannotBeReinitialized` began by assuming an already
initialized account — `require configVersion() != 0` — which excludes
`configVersion == 0` by hypothesis. `formal/lean/Loom/ProxyInitialization.lean`
models storage separation and has no caller-authority model.

The two contexts are distinguishable without any new state. During a constructor,
`extcodesize(address(this))` is zero, and a delegated EOA always carries the
23-byte `0xef0100 || template` delegation indicator as its code.

Code length alone is sufficient, and no companion check on the runtime's own
address is needed. The permitted zero-code context is unreachable by an external
call: an account under construction has no code, so a call to it dispatches no
runtime and returns success without executing anything. The strongest position an
attacker can occupy is a malicious module invoked from `_initialize`'s install
loop, which runs inside the constructor window;
`testExternalCallCannotReachTheConstructorInitializationWindow` demonstrates that
it still cannot reach the initializer. Only the proxy constructor's own
delegatecall executes the runtime in that context, atomically with deployment.

## Options

- **Restrict `initialize` to the proxy-construction context.** Keeps the
  selector, so counterfactual addresses are unchanged, and needs no new signature
  surface. Requires the guard to be exact about what "proxy construction" means.
- **Add an EIP-712 signed delegated-initialization path** binding chain id,
  template code hash, EntryPoint, guardian configuration, the ordered module set,
  a nonce, and a deadline, so a third party can publish the initialization.
  Rejected for now: it does not fix `initialize`, which is the actual hole, and it
  adds a signature surface with its own replay burden to solve a problem the EOA
  self-call already solves. Worth revisiting only if sponsored initialization
  becomes a requirement, and it must not become mandatory infrastructure.
- **Move the EIP-7702 runtime into a separate contract with ERC-7201 namespaced
  storage.** Structurally prevents both this bug and storage collision with a
  prior delegation target, but duplicates security-critical account logic —
  explicitly rejected in ADR 0001 — and changes the storage layout of existing
  proxy accounts, which would need a new runtime version and an explicit user
  migration.

## Decision

`initialize` reverts with a distinct `InvalidInitializationContext` error unless
`address(this)` has no code. This adds no storage slot and no immutable, so the
append-only storage layout and the initializer's selector are both unchanged —
existing counterfactual account addresses are unaffected.

A proxy inside its own constructor is the only account that satisfies the guard.
`initialize` can no longer reach a delegated EOA, an already-deployed proxy, or
the template itself. Delegated accounts keep using
`initializeDelegatedAccount`: requiring the EOA to send the transaction means the
EOA key authorizes the exact payload, the EOA's transaction nonce provides replay
protection, and the transaction's chain id provides chain separation.

The error is deliberately distinct from `InvalidInitialization` so a test cannot
satisfy the one-shot property by tripping the context guard, or the reverse.
`check_InitializedAccountCannotBeReinitialized` now self-calls
`initializeDelegatedAccount`, the only initializer an initialized account can
still reach, which keeps that property's failure provenance exact.

Acceptance requires: an external caller calling `initialize` on an uninitialized
delegated EOA reverts with `InvalidInitializationContext` and installs no
EntryPoint, guardian configuration, or module; the owner can still
self-initialize afterwards; the template rejects `initialize` on itself; a module
invoked during construction cannot reach the initializer; proxy deployment and
existing counterfactual addresses are unchanged; a Certora rule covers
`initialize` with no `configVersion` precondition; and a mutation removing the
guard fails the regression test.

## Residual risks

Storage collision is unaddressed. An EOA that previously delegated to an
unrelated contract may hold dirty storage. Loom's slots are read as
`configVersion`, `entryPoint`, and so on regardless of what wrote them, so a
non-zero leftover in the `configVersion` slot blocks initialization, and other
leftovers would be read as Loom configuration. Clients must verify that a
delegated account's Loom-visible state is empty before initializing. An
ERC-7201-namespaced 7702 runtime profile would remove this class of risk and
remains the preferred long-term direction.

The guard assumes `extcodesize(address(this))` is zero only during construction.
That holds under current EVM semantics for both CREATE and CREATE2.

7702 authorization UX risk from ADR 0001 is unchanged: users must still verify
the template address, runtime bytecode, EntryPoint binding, and chain before
signing a delegation.
