# Session Permission Profiles

Loom provides two validator profiles with deliberately different authority
surfaces. Both profiles authorize only ERC-4337 UserOperations and always
reject arbitrary ERC-1271 messages.

## Exact-call sessions

`ExactCallSessionValidator` binds a permission to the hash of one complete account
call. It is the narrowest profile and should be preferred for known,
pre-constructed operations.

## Granular sessions

`GranularSessionValidator` permits reusable single calls or atomic batches
while enforcing all of the following:

- Exact execution target and function selector.
- Optional standard ERC-20 token semantics for `transfer`, `transferFrom`, or
  `approve`.
- Optional exact ERC-20 recipient or spender.
- Maximum amount per call and maximum aggregate amount per UserOperation.
- Maximum calls per UserOperation.
- Valid-after and valid-until timestamps.
- Maximum ERC-4337 nonce sequence, used as the permission use limit.
- Exactly one selected paymaster; the zero address requires account-funded
  native gas.

Every execution in a batch must satisfy the same permission. Mixed targets,
mixed selectors, malformed token calldata, empty batches, unsupported
execution modes, token calls carrying native value, and amounts outside the
configured limits fail closed.

Permission grants and replacements require the account's configuration
timelock and advance `configVersion`. Revocation is immediate. Permission IDs
are enumerable for wallet permission-management interfaces and capped per
account to keep queries bounded.

Both session validators derive the ERC-4337 nonce key from the first 192 bits
of the permission ID. A second permission that would share an existing nonce
key is rejected, even if the full 32-byte permission ID differs. This avoids a
footgun where two visibly different permissions compete for the same EntryPoint
nonce sequence.

## What a permission does not constrain

A granular permission binds the target, the selector, and the amount. It does
**not** constrain the rest of the calldata. For a token permission the remaining
arguments are the recipient and amount, and both are checked. For any other
permission — `(target, selector)` with `token == address(0)` — the arguments are
free, and only attached native value is metered.

That is the intended capability range, not an oversight: a granular session is
"this key may call this function on this contract", and enumerating the argument
shape of every third-party function is not something the account can do. Two
consequences follow, and a wallet client must surface both.

**A target that dispatches is as wide as the target.** A permission for a
selector that forwards calls — `multicall`, `aggregate`, `exec`, a router's
generic swap entry point — grants whatever that contract is willing to do on the
account's behalf, because the forwarded call lives in the unconstrained
arguments. Loom does not carry a denylist of such selectors: the set is open,
target-specific, and unknowable to the account, so a denylist would block a few
familiar names while advertising a boundary it does not have. Use
`ExactCallSessionValidator` when the call is known in advance; it pins the
calldata hash and is immune to this by construction.

**The account and its modules are not valid targets.** This is the one case
where the account *can* enumerate the risk, so it does. A permission whose
target is the account itself is rejected at grant time, and a permission whose
target is an installed validator, hook, or recovery module fails validation for
as long as it stays installed. An execution item targeting the account arrives
at its own `onlySelf` surface with `msg.sender == address(this)`, so an
unconstrained argument list on a single permitted selector would be account
authority rather than a spending capability: `scheduleCall` takes the call to
queue, `scheduleMigration` takes the destination, `unfreeze` lifts a guardian's
emergency window, and `RecoveryManager.cancelRecovery` discards a pending
guardian recovery. The module check reads the current module set rather than the
one observed at grant time, so an address that becomes a module later is denied
from that point on without the permission having to be revoked. See
`test/regression/SessionAdministrativeTargets.t.sol`.

`ExactCallSessionValidator` is not subject to either restriction, because a
pinned calldata hash is a specific call the granter reviewed during the
configuration timelock rather than a standing capability.

## Deliberate limits

- A granular permission does not authorize delegatecall, executors, fallback
  handlers, arbitrary typed-data signatures, or contract creation.
- Token amount parsing supports only canonical ERC-20 calldata. Non-standard
  token methods require a separately reviewed validator profile.
- The use limit relies on EntryPoint nonce uniqueness. Wallet clients must use
  the validator-reported nonce key for the permission and must not present the
  limit as a spend counter.
- ERC-7715 request translation and ERC-5792 capability reporting belong to a
  future wallet client. The client must display the exact on-chain permission,
  not a broader or friendlier approximation.
