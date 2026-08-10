# ADR-0022: No delegatecall system engines

## Status

Accepted. This closes a design direction rather than opening one.

## Context

Making the account transport-agnostic (ADR 0020) raises an obvious next step:
route unknown selectors to installable "system engines" through `delegatecall`,
so a future standard's account-side code can be added without a new
implementation. The construction usually proposed is a selector route plus a
pinned code hash:

```solidity
fallback() external payable {
    EngineConfig memory engine = _engines[_selectorRoutes[msg.sig]];
    if (engine.implementation.codehash != engine.pinnedCodeHash) revert EngineCodeChanged();
    _delegate(engine.implementation);
}
```

This is attractive because EIP-8141's `APPROVE` must execute in the sender's
context, which an ordinary external call cannot provide (ADR 0021).

## Decision

The account does not `delegatecall` anything. There is no system-engine slot, no
selector-routed delegation, and no capability that grants one.

### It is an upgrade key

A contract reached by `delegatecall` writes the account's storage. Loom's layout
is one append-only block holding the module registry, `guardianRoot`,
`guardianThreshold`, `frozenUntil`, `configVersion`, and the pending migration
(`src/LoomAccount.sol:146-166`). Whatever occupies that slot can install itself
as a validator, rewrite the guardian root, clear the freeze, and move every
asset.

`docs/design/architecture.md` states that delegatecall execution modes are
deliberately rejected, and decision 0004 states the account has no upgrade
mechanism, no admin, and no privileged factory operation. A slot whose occupant
can rewrite account storage is an upgrade mechanism. Naming it an engine does
not change what it can do, and the timelock that guards installing it is the
same timelock that guards installing a validator — a defence sized for a module
that can be refused at call time, not for one that cannot.

### Pinning the code hash does not fix it

The pinned-hash version fails for a reason already documented in this
repository. Guardian leaves bind `verifier.codehash`, and
`docs/design/architecture.md` states plainly that this pins the code deployed at
an address but that a `codehash` is stable across an upgradeable proxy's
implementation changes. Pinning the code hash of a proxy pins nothing: the
proxy's own code never changes while its behaviour does. Re-checking
`extcodehash` on every dispatch has the same hole, because it re-checks the same
unchanging proxy.

The mitigation for guardian verifiers — use only immutable deployments, enforced
by review and deployment profile — is a convention. A convention is an adequate
guard for a contract that returns a boolean. It is not adequate for one that can
rewrite the account.

### The account-context requirement is real, and has a different answer

EIP-8141 genuinely needs code running at the account's address. That code
belongs in the account's own immutable implementation. It makes 8141 support a
new implementation generation, reached through the migration path decision 0004
already defines, rather than a hot-swap.

That is more expensive and it is the point: adopting a new execution standard
should cost a deliberate, visible migration, not an install transaction. The
alternative buys convenience by making every Loom account permanently one
configuration change away from total loss.

## Consequences

Loom cannot add account-context support for a future standard without shipping a
new implementation, and therefore new counterfactual addresses. The exit is the
migration primitive, which exists for exactly this and commits to a destination
code hash the user can inspect during the delay.

The account keeps the property that reading its implementation tells you
everything that can run at its address.

## Residual risks

This closes the cheapest path to future standards. If a standard arrives that
requires account-context code and Loom has live accounts, those users migrate or
stay on the old transport. That cost is real and is accepted here in exchange for
the account having no code path that can rewrite its own authority.

The decision constrains Loom's own contracts. It does not stop a user delegating
their EOA to a different implementation under EIP-7702; that is their address and
their choice, and decision 0001 covers what Loom does when it is the delegation
target.
