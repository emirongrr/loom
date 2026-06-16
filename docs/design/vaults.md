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

## Vault path

Large withdrawals are visible and delayed. A user first schedules a vault
withdrawal through the account. Because this changes hook state, the scheduling
call itself must pass through the account's delayed configuration path. After
the vault delay, the user or any public executor can execute the exact
scheduled account operation during the configured withdrawal window.

Guardian-threshold cancellation can remove a pending withdrawal without giving
guardians transfer authority. Guardian approvals are verified against the
account guardian root and reject duplicate leaves.

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
