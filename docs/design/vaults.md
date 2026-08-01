# Vault Architecture

Loom separates daily spending from long-term storage through an optional hook
module. The immutable account core stays small: it executes calls, enforces
installed hooks, applies timelocks, and exposes migration/recovery surfaces.
Vault policy lives outside the core so users can replace or remove it through
the same delayed configuration path as any other hook.

## Security model

`VaultHook` protects a configured asset with two paths:

1. Small transfers up to the configured per-period limit execute immediately.
2. Larger withdrawals require an exact pending vault withdrawal, the account's
   scheduled execution delay, and the vault-specific delay.

The pending withdrawal commitment binds:

- account
- target
- native value
- calldata hash
- current `configVersion`

This makes vault withdrawals exact. A pending withdrawal for one token
transfer cannot be reused for another target, amount, selector, calldata, or
post-configuration-change account state.

## Daily account

The daily account path is for payments, DeFi interactions, and ordinary use.
For protected ERC-20 assets, the hook recognizes canonical `transfer`,
`transferFrom` from the account, and `approve` calldata. For native ETH, the
hook uses the execution value as the protected amount.

Spending accounting is updated in the hook pre-check. If the inner account
execution later reverts, the whole transaction reverts and the accounting
rolls back with it.

## Token compatibility matrix

The policy and vault hooks meter the amount requested by canonical ERC-20
`transfer`, `transferFrom`, and `approve` calldata. They do not decode or
endorse token return data. A successful account call therefore means the token
call did not revert; it does not turn a `false` return value into token-level
success.

| Token class | Loom support level | Evidence and boundary |
|---|---|---|
| Boolean-return ERC-20 | Supported | Pinned mainnet USDC transfer tests assert exact balances, requested-amount policy accounting, exact limit error, and full rollback. |
| No-return ERC-20 | Supported | Pinned mainnet USDT transfer tests exercise the deployed no-return implementation with the same accounting and rollback assertions. |
| Wrapped native token | Supported as ERC-20 after wrapping | Pinned mainnet WETH deposit and transfer tests prove exact vault accounting. Native value used to wrap remains subject to any configured native-asset policy. |
| ERC-4626 shares | Shares supported as canonical ERC-20 | Pinned mainnet sDAI deposit plus share transfer tests prove share-balance and vault accounting. `deposit`, `mint`, `withdraw`, and `redeem` economics are not interpreted by the generic hooks. |
| Fee-on-transfer | Restricted | PR tests prove the requested amount, not the recipient's net amount, consumes policy budget. Fees and token valuation are not modeled. |
| Rebasing | Unqualified | Generic transfer calldata can execute, but balances and limits are not adjusted for rebases. Do not treat a rebasing asset as protected without an asset-specific review. |
| Callback-capable/ERC-777-like | Unqualified | Account execution is reentrancy-guarded, but callback and operator semantics are not part of the supported token profile. |
| `false` return | Executed but not reported as token success | PR tests prove balances remain unchanged while the requested amount is conservatively consumed. Integrators must inspect token semantics or use a specialized adapter. |
| Reverting or malformed token | Fails closed | PR tests require exact bubbled errors and accounting rollback; malformed canonical calldata cannot fit under a configured limit. |

The real-token rows run against Ethereum mainnet block `20,000,000` using the
deployed USDC, USDT, WETH, DAI, and sDAI contracts. `MAINNET_RPC_URL` must point
to an archive-capable caller-selected endpoint. The endpoint is never stored in
the repository or test output. Mock behavior tests run on every pull request;
the pinned fork matrix is a nightly and release qualification gate.

## Vault path

Large withdrawals are visible and delayed. A user first schedules a vault
withdrawal through the account. Because this changes hook state, the scheduling
call itself must pass through the account's delayed configuration path. After
the vault delay, the user or any public executor can execute the exact
scheduled account operation during the configured withdrawal window.

Guardian-threshold cancellation can remove a pending withdrawal without giving
guardians transfer authority. Guardian approvals are verified against the
account guardian root and reject duplicate leaves.

A cancellation authorizes exactly one withdrawal instance. A withdrawal is
stored under an identifier derived from the account, target, value, calldata
hash, and configuration version, so re-scheduling the same withdrawal reuses
that slot. Each slot carries an instance counter which the cancellation digest
binds and which advances whenever the slot is consumed by either cancellation or
successful execution. Consumption clears the pending fields but keeps the
counter, so `readyAt == 0` still means "not pending" while the counter continues
across instances.

Without that counter the approvals published by one cancellation stayed valid
for every later withdrawal occupying the same slot. Because the cancellation
entry point is permissionless and gated only by signature validity, anyone could
replay the archived approvals to cancel each re-scheduled withdrawal
indefinitely, with no live guardian participation. The counter is per slot
rather than per account so that cancelling one withdrawal does not change the
identity of other pending withdrawals; this differs from `RecoveryManager`,
where an account has at most one pending recovery and a single per-account nonce
is sufficient.

## Deliberate limits

The initial hook protects canonical ERC-20 calldata and native ETH. It does
not price tokens, model rebasing or fee-on-transfer behavior, understand
bridges, or inspect arbitrary DeFi position accounting. Those are client and
asset-specific responsibilities unless an audited specialized hook is added.

Vault policy is not a substitute for privacy. A public pending withdrawal can
reveal timing and target metadata. Privacy-preserving movement belongs in
separate audited adapters or privacy systems; the vault hook's job is to make
large public movements delayed, cancelable, exact, and visible.

## Ecosystem comparison

Safe's allowance module uses a module-scoped allowance ledger with reset
periods, nonces, delegate signatures, query surfaces, and explicit delete/reset
operations. Argent's wallet architecture also separates guarded, recoverable,
lockable, and session behavior into modules. Loom follows the same broad
lesson: spending policy should be narrow and modular. It intentionally avoids
turning the vault into an unrestricted module executor or a registry-governed
authority.
