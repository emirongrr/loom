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

## Deliberate limits

- A granular permission does not authorize delegatecall, executors, fallback
  handlers, arbitrary typed-data signatures, or contract creation.
- Token amount parsing supports only canonical ERC-20 calldata. Non-standard
  token methods require a separately reviewed validator profile.
- The use limit relies on EntryPoint nonce uniqueness. Wallet clients must use
  the permission ID as the ERC-4337 nonce key and must not present the limit as
  a spend counter.
- ERC-7715 request translation and ERC-5792 capability reporting belong to a
  future wallet client. The client must display the exact on-chain permission,
  not a broader or friendlier approximation.
