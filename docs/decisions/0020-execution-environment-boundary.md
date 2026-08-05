# ADR-0020: Execution environment boundary

## Status

Accepted. The boundary exists in `src/LoomAccount.sol`; no second environment is
implemented, and none is designed for here.

## Problem

Loom already separates policy and signature checking from the account: the core
receives a decoded `(validator, validatorSignature)` pair and delegates to
`ILoomValidator` (`src/LoomAccount.sol:314-331`). What is not separated is the
transport shape — how an external caller gets the account to execute anything.
Exactly one such shape is wired into the core, ERC-4337, at five places:

| Location | Surface |
|---|---|
| `src/LoomAccount.sol:11` | `PackedUserOperation` import |
| `src/LoomAccount.sol:147`, `:1026` | `entryPoint`, written only during initialization |
| `src/LoomAccount.sol:285-288` | `onlyEntryPoint` |
| `src/LoomAccount.sol:308-339` | `validateUserOp` |
| `src/LoomAccount.sol:1220-1225` | `_paymaster`, which decodes `paymasterAndData` |

Nothing else in the contract set is coupled to it. `src/hooks/`, `src/recovery/`,
`src/keystore/`, and `src/validators/` contain no reference to `entryPoint` or
`PackedUserOperation`.

ERC-4337 is not guaranteed to be the permanent shape of account abstraction. If
a successor arrives, the account should gain support by adding a thin entry
function, the way inbound ERC-7579 support was added by a shim (decision 0010),
without touching storage layout, authority state, or validator, hook, and
guardian logic.

One constraint is hard and cannot be designed around: ERC-4337 requires the
account itself to expose `validateUserOp` at a fixed selector, because the
EntryPoint calls the sender address directly. While ERC-4337 support is offered,
that function stays on the account. What is achievable is making it a mechanical
translation with no authority logic in it.

## Decision

Define one internal boundary and route every environment through it:

```solidity
function _validateAuthority(
    bytes32 operationHash,
    uint256 nonce,
    bytes calldata signatureEnvelope,
    bytes calldata callData,
    address paymaster
) internal returns (uint256 validationData)
```

Above it is transport, below it is authority. `validateUserOp` decodes the
fields it needs out of `PackedUserOperation` and calls this. A second
environment adds its own entry function that decodes its own calldata shape and
calls the same function.

Two things stay inside the boundary rather than being passed to it, and both are
load-bearing:

- The signature-envelope decode (`_tryDecodeSignature`) and the
  `_modules[ModuleType.VALIDATOR][validator]` check. If an adapter supplied the
  validator address, every adapter would have to repeat the installed-module
  check, and an adapter that forgot it would be an authorization bypass. Keeping
  both here means an adapter cannot forget them.
- The `try`/`catch` that maps a reverting validator to `SIG_VALIDATION_FAILED`.
  This is the fail-closed behaviour dispositioned as MEDIUM-04 in
  `docs/reviews/preliminary-review-disposition.md`; it is one boundary, not one
  per environment.

The prefund transfer stays in `validateUserOp` and is deliberately not a
parameter of the boundary. Paying the EntryPoint is settlement, not
authorization, and a second environment's adapter should not have to pass a
meaningless zero for it.

### One privileged caller per environment, not a registry

The account keeps a single `entryPoint` slot, set at initialization and never
written again. A second environment gets a second append-only slot, not an
entry in a mutable set of trusted callers.

A mutable set raises the question of who may add to it. Answering it with a
timelocked self-call adds authority surface and a `configVersion` interaction
for no gain; answering it with "nobody" makes it a fixed list, which is a slot
with extra steps. A write-once slot per environment matches the account's
posture everywhere else, including the immutable implementation binding in
decision 0004.

`execute`'s caller check becomes `_isExecutionEnvironment(msg.sender)`, so that
adding an environment touches one predicate rather than a condition spread
across call sites.

### Signing domains, and what the two current transports actually bind

A second environment must not be able to replay an authorization made for the
first. The requirement is that every engine signs in a distinct domain and binds
the call it authorizes.

An explicit `engineId` field in the signed struct was considered and rejected as
ceremony. The account computes the digest from its own constant, not from a
value an engine supplies, so an `engineId` constant and a distinct typehash
string produce exactly the same separation. Adding the field would make the
signed data more self-describing and buy no security property. The rule is
therefore stated as a requirement on new engines rather than encoded as a field:

- a new engine defines its own typehash, and must not reuse another engine's;
- its digest binds the account, chain, mode, execution-calldata hash, a nonce
  under that engine's control, and an expiry;
- reusing `ILoomDirectValidator` is allowed, reusing `DIRECT_EXECUTION_TYPEHASH`
  is not. That interface is the natural one for "validate this exact account
  call", so a second engine copying the struct is the concrete replay this rule
  prevents.

The two transports that exist today already satisfy this, and they are not
symmetric. `directExecutionDigest` (`src/LoomAccount.sol`) binds
`configVersion`, so any configuration change voids a pending direct signature.
The ERC-4337 path binds nothing of the sort: `userOpHash` covers the
EntryPoint's own fields, and neither the account nor `P256Validator` or
`ECDSAValidator` adds `configVersion`. A UserOperation signed before an
unrelated hook install stays valid after it.

That difference is defensible and is recorded rather than removed. The 4337 path
is already single-use through the EntryPoint's two-dimensional nonce, a recovery
that replaces the validator set makes the operation fail the installed-module
check, and hooks are read at execution time so a newly installed policy still
applies. Binding `configVersion` there would void every in-flight bundled
operation on every configuration change, which is a liveness cost paid for a
guarantee the other three mechanisms already provide.

A third engine must state which of the two it follows. "It is like the other
one" is not an answer when the two differ.

### What a protocol-level environment would need

The extension procedure above was written against the shape ERC-4337 has: a
deployed EntryPoint contract that calls a fixed selector. Protocol-level account
abstraction does not have that shape, and checking the boundary against a real
proposal found two assumptions worth naming before they harden.

EIP-8141 (Frame Transaction, Draft) decomposes a transaction into frames.
Validation is a `VERIFY`-mode frame delivered as a `STATICCALL` from the
protocol entry point at address `0xaa`, running arbitrary code at the sender
rather than a standardised function, and success is signalled by executing a new
`APPROVE(scope)` instruction instead of returning a value. RIP-7560 differs in
detail — a fixed `validateTransaction` selector, a magic return value — but
shares the part that matters here: the caller is a protocol address, not a
contract someone deployed.

Three consequences:

- **The caller must be a constant, not an initialized slot.** `_initialize`
  requires `entryPoint_.code.length != 0` (`src/LoomAccount.sol:1020`), which is
  correct for ERC-4337 — an EntryPoint with no code is a misconfiguration that
  bricks the account — and wrong for `0xaa`, which has no code by construction.
  A protocol-level environment therefore adds a `constant`, not a storage slot,
  and that check must not be generalised into a shared helper. This is cheaper
  than the slot the procedure above describes, so the procedure's step 2 reads:
  a write-once slot for a deployed environment, a constant for a protocol one.
- **A `STATICCALL` validation frame cannot write storage.**
  `ILoomValidator.validateUserOp` is non-view, so a stateful validator would
  revert inside such a frame. The boundary already maps that to
  `SIG_VALIDATION_FAILED` rather than propagating it, so the failure mode is a
  refused operation, not a bricked account — but under a protocol-level
  environment, only stateless validators would be usable. That is a property of
  the validator interface, not of this boundary, and is not changed here.
- **Signalling success is the adapter's job.** Where ERC-4337 returns packed
  `validationData` and EIP-8141 executes `APPROVE`, the entry function reads the
  boundary's result and translates. This is the same "translate on the way out"
  the consequences section describes, and it is why the boundary returns a value
  rather than performing the signalling itself.

None of this is implemented. EIP-8141 is Draft and RIP-7560 is not final;
building against either now would be designing against a moving specification.
What is recorded here is the shape of the seam, so that the first adapter does
not have to relitigate the core.

### No speculative interface

There is no `IExecutionEnvironment`. A Solidity interface covering a standard
nobody has specified would be wrong in a way that is expensive to correct, and
the architecture is explicit elsewhere about scoping to what exists — the
ERC-7579 profile is narrow by design, and the privacy layer is reached through a
structural adapter rather than inherited.

The extension procedure is a process guarantee instead:

1. Add an external entry function that decodes that standard's calldata, calls
   `_validateAuthority`, and translates its result into whatever that standard
   uses to signal success.
2. Add that standard's privileged caller: a write-once slot if it is a deployed
   contract, a `constant` if it is a protocol address. See the next section for
   why the distinction matters.
3. Add one disjunct to `_isExecutionEnvironment`.
4. Change nothing else. `_executeAuthorized` and everything below it — freeze,
   hooks, guardians, migration, scheduled calls — stays untouched.

### Why no new file

`ERC7579ValidatorShim` works as a separate contract because it sits on the
module side, where Loom is the caller. An execution environment calls *into* the
account at a selector the standard fixes, so the same trick does not apply:
ERC-4337 compliance requires `validateUserOp` on the account itself.

Extracting the body into a library was rejected on measurement, not taste. On
the `#313` branch, moving comparable logic out of `LoomAccount` made the runtime
*larger* twice — 676 bytes for the dependency probe, 30 bytes for guardian
verification — because `internal` library functions are inlined and produce no
saving, while `public` library functions add ABI-encoding scaffolding at every
call site. `LoomAccount` has 843 bytes of EIP-170 margin, so a change that
spends margin to buy indirection is the wrong trade.

## Consequences

The account's ERC-4337 knowledge is confined to `validateUserOp`, `_paymaster`,
the prefund transfer, `onlyEntryPoint`, and one storage slot. Adding a second
environment is additive.

Measured, not predicted, and it costs more than the shape suggests. The runtime
grows 23 bytes, from 23,733 to 23,756, leaving 820 bytes of EIP-170 margin.
Account deployment costs about 4,600 gas more — 148 of 302 snapshot entries
rise, all of them account-deploying tests, by a median of 4,620, which is 23
bytes at 200 gas per byte.

The cost is entirely in the two helpers having more than one caller.
`_validateAuthority` itself is free: one caller, so the optimizer inlines it.
`_isExecutionEnvironment` is reachable from `onlyEntryPoint` and `execute`, and
`_resolveInstalledValidator` from `_validateAuthority` and `isValidSignature`,
so neither inlines. The second of those also shows in runtime: the ERC-1271 and
malformed-envelope path costs about 1,082 gas more, a 1.57% move on
`ECDSASignatureBoundaryTest`, which is the largest change anywhere and the only
one above the 1% snapshot tolerance.

That is the honest trade. Extracting the shared "which validator, and is it
installed" step removes a duplicated authorization check — an ERC-1271 path that
drifted into accepting an uninstalled validator would be a signing oracle for a
module the account rejected — and it pays about 1,000 gas on signature checks
and 23 bytes of a margin that is this contract's binding constraint. Worth it
here. The next change to spend that margin should say what it bought.

Two ERC-4337 shapes remain visible past the boundary and are not removed here:

- `ILoomValidator.validateUserOp(account, userOpHash, nonce, signature,
  callData, paymaster)` returning packed `validationData`
  (`src/libraries/ValidationDataLib.sol`) is ERC-4337's profile and result
  encoding. Changing it would break every validator and every module written
  against it. A future environment's entry function translates on the way out
  rather than teaching validators a second dialect.
- `ILoomHook.preCheck(account, caller, accountCall)` shows hooks the caller,
  which is the EntryPoint on the 4337 path. Neither shipped hook reads it
  (`src/hooks/PolicyHook.sol:95`, `src/hooks/VaultHook.sol:179` both leave the
  parameter unnamed), so this is a latent leak, not an active one. A hook that
  began policying on caller identity would couple itself to the environment.

`accountId()` still reports a single account identity regardless of environment,
which is correct: the account is one account reachable two ways, not two
accounts.

## Residual risks

The boundary is a process guarantee, not a compiler-enforced one. Nothing stops
a future contributor from putting authority logic in an entry function instead
of below the boundary. The mutation manifest is where that is caught: removing
the installed-module check inside `_validateAuthority` must kill a mutant.

`validationData` remains ERC-4337-encoded, so a standard with incompatible
validity semantics would need translation that could lose information. This is
recorded rather than solved, because solving it speculatively means designing
against an unwritten specification.
