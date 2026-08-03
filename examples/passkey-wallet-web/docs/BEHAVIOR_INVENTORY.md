# Behavior inventory

This inventory is the regression contract for the incremental application refactor. No browser storage key is removed or reset by this work.

## Preserved

- Saved Wallet listing, account-scoped passkey unlock, switch and lock.
- Non-destructive migration from legacy single-wallet and multi-wallet records; malformed records are isolated and healthy records remain visible.
- Basic and advanced guardian-protected wallet creation, counterfactual activation, native/token/collectible transfer, balances, activity and apps.
- Automatic guardian verifier selection from live chain evidence, delayed guardian-set changes, individualized one-time invitations, accepted-capability isolation and freeze preparation.
- Full recovery lifecycle: account verification, encrypted recovery-passkey draft, permissionless validator publication, guardian responses, proposal, enforced delay, execution and linking the recovered passkey to the existing Saved Wallet identity.
- Factory gas payment by another eligible Saved Wallet and developer endpoint settings.

## Intentionally changed

- A UserOperation is successful only when its receipt reports `success: true`, matches the submitted hash and sender, and contains a valid transaction hash.
- Conflicting operations for one account are rejected locally while an operation is in flight.
- Raw RPC, bundler and WebAuthn errors are normalized into safe user messages; stable error code/stage data is shown only under Advanced details.
- Runtime chain ID, bundler EntryPoint support and manifest-pinned runtime bytecode commitments are checked before authority-changing ceremonies.
- Dialogs use semantic forms, trap and restore focus, support Escape while safe, and expose busy/error state to assistive technology.

## Removed

- No user feature, wallet record, guardian record, recovery session or passkey metadata is removed.
- A receipt-less “submitted means successful” activation path is removed; an unconfirmed operation remains unconfirmed.

## Unverified outside mocks

- Physical authenticator UX, browser-specific WebAuthn prompts and platform passkey synchronization.
- Public bundler availability, fee policy and live Sepolia inclusion latency.
- Explorer/indexer completeness and finality lag.
- Recovery and guardian ceremonies across multiple physical devices and independent origins.

These boundaries require the manual device and live-infrastructure checklist in the README; mock transport tests do not claim to prove them.
