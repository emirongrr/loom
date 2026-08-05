# ADR-0021: Native AA transports that bypass account code

## Status

Accepted as a constraint on future work. Nothing is implemented; this records
what a native account-abstraction transport would cost Loom before anyone builds
one, because two of the costs are not recoverable by design choices made later.

## Context

ERC-4337 reaches the account through the account's own code: the EntryPoint
calls `validateUserOp` on the sender, and execution arrives at `execute`. Every
Loom guarantee that depends on running code — hooks, freeze, batch bounds,
`configVersion` invalidation — holds because there is no other way in
(`src/LoomAccount.sol:353-356`, `:413-468`).

Two draft proposals break that assumption in different ways.

EIP-8130 (Account Abstraction by Account Configuration, Draft; announced by Base
for the Cobalt upgrade) puts authentication in authenticator contracts and actor
configuration in a protocol contract at `ACCOUNT_CONFIG_ADDRESS`. It imposes **no
account interface at all** — the protocol is agnostic to account bytecode — and
dispatches each call directly from the sender to its target, with
`msg.sender == sender`. An actor is bound to an authenticator that returns an
`actorId`, and carries a scope bitmask: `0x00` admin, `0x01` SENDER (ungated
initiation), `0x02` POLICY (initiation gated through one `policy_manager`
address that validates an opaque 32-byte `policy_commitment`), `0x04` NONCE,
`0x08` SELF_PAYER, `0x10` SPONSOR_PAYER.

EIP-8141 (Frame Transaction, Draft) is the opposite shape: validation is a
`VERIFY`-mode frame delivered as a `STATICCALL` from the protocol entry point at
`0xaa`, running the account's own code, and approval is granted by executing the
`APPROVE` instruction in the sender's context.

## The two consequences that are not design choices

### An 8130 actor with SENDER scope voids the policy layer

Loom's spending limits, target and selector restrictions, and vault accounting
run in `_preCheck`/`_postCheck` inside `_executeAuthorized`
(`src/LoomAccount.sol:429-443`). If the protocol dispatches a call from the
sender directly to a token contract, none of that executes. The account's own
`PolicyHook` and `VaultHook` are not bypassed by a bug; they are simply not on
the path.

The only configuration in which Loom's guarantees survive on such a chain is
POLICY scope with `policy_manager` pointing at a Loom contract that reproduces
the checks. That is not one option among several. Granting an actor SENDER scope
silently converts a policy-constrained account into an unconstrained one, and
nothing in the account can detect or refuse it.

### 8130 actor configuration is outside `configVersion`

`_advanceConfig` (`src/LoomAccount.sol:1051`) is the anti-stale-authority spine:
every authority mutation advances it, and every pending operation, migration,
recovery, and vault withdrawal binds the version it was created at. That works
because all of them are account state.

An 8130 actor is not account state. It lives in the protocol's configuration
contract, and the protocol does not consult `configVersion` when authorising an
actor. So guardian recovery can replace the entire validator set, advance
`configVersion`, and invalidate every pending operation — while a compromised
actor stays authorised.

This is not a synchronisation bug to be fixed by having the recovery engine
update both. It is two authorities over one address, updated through two
mechanisms, with no guarantee they can be updated atomically. Recovery that
succeeds against one and fails against the other leaves the account recovered on
paper and compromised in fact.

### 8141 needs account-context code, which means an implementation, not a module

`APPROVE` is only meaningful when executed by code running at the sender's
address, and the `VERIFY` frame is a `STATICCALL`, so it cannot write state.
Loom cannot satisfy this with an external contract called normally, and it will
not satisfy it with a `delegatecall`-able module (ADR 0022). The remaining
option is that the code lives in the account's own immutable implementation,
which makes 8141 support a new account generation rather than an installable
engine.

The `STATICCALL` also bounds which validators are usable: `ILoomValidator`
`validateUserOp` is non-view, so a stateful validator would revert inside a
`VERIFY` frame. The account's boundary already maps a reverting validator to
`SIG_VALIDATION_FAILED` (`src/LoomAccount.sol`, `_validateAuthority`), so the
failure mode is a refused operation rather than a stuck account — but only
stateless validators would work on that path.

## Decision

Record these as constraints now, and require any future native-AA work to state
which of them it accepts:

1. Loom must never configure an 8130 actor with SENDER or admin scope. A Loom
   account on an 8130 chain uses POLICY scope with `policy_manager` pointing at
   a Loom-controlled contract, or it does not use 8130.
2. Any 8130 integration must publish, in the same change, how recovery revokes a
   protocol-level actor, and what the account's state is if that revocation
   fails while the account-side replacement succeeds. "Both are updated" is not
   an answer unless it is atomic.
3. 8141 support is an implementation generation, not a module install.
4. Neither is implemented against a draft. EIP-8130 and EIP-8141 are both Draft;
   building either into a shipped account means shipping against a specification
   that can still change.

## Consequences

Loom can support ERC-4337 today and add a native transport later without
changing its authority model, provided the transport reaches the account through
account code. A transport that does not — 8130's direct dispatch is the concrete
example — is not a transport adapter for Loom. It is a second authority over the
same address, and adopting it is a change to what a Loom account guarantees, not
an integration.

## Residual risks

Both proposals are Draft and this record describes them as of the drafts read
while writing it. If 8130 gains an account-side hook for actor changes, or a way
to bind actor authorisation to account state, consequence 2 weakens and should
be revisited rather than inherited.

Nothing here prevents a user from configuring an 8130 actor directly against the
protocol contract, outside anything Loom controls. The account cannot prevent
it and should not claim to.
