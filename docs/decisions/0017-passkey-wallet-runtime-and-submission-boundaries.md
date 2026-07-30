# ADR-0017: Passkey wallet runtime and submission boundaries

## Status

Accepted for the `examples/passkey-wallet-web` reference application.

## Context

The application previously constructed RPC clients inside feature components and could present an ERC-4337 submission as successful without proving the final receipt outcome. Deployment addresses alone also did not commit the browser application to the runtime bytecode it intended to trust.

Wallet UI state is not an authority boundary. RPCs and bundlers can be faulty or malicious, browser storage can be partially corrupt, and a submitted UserOperation may later revert. The application must keep signing authority in the passkey/account, remain usable with replaceable infrastructure, and fail closed without introducing a Loom-operated coordinator.

## Decision

- Browser I/O is created behind `AppServices`; read-only public clients are cached per endpoint and components do not construct them.
- Deployment metadata commits to chain ID, EntryPoint and runtime code hashes for the account factory, implementation, validators, hooks, recovery module and guardian verifiers.
- Before a passkey ceremony that creates or transfers authority, the application verifies RPC chain identity, bundler EntryPoint support and relevant runtime commitments.
- Account operations use one explicit lifecycle state and one in-flight operation per account. A submitted operation remains “confirming” across uncertainty.
- Success requires a receipt with matching UserOperation hash, matching sender when supplied, `success: true`, and a transaction hash. Timeout or malformed provenance cannot become success.
- Diagnostic causes remain local and are redacted; user-visible errors expose safe messages plus non-sensitive code/stage metadata.
- Storage migration and parsing are record-isolating and non-destructive. No reset/delete escape hatch is introduced.

## Consequences

RPC and bundler censorship can still deny availability, but neither becomes account authority. A wrong or stale runtime profile blocks operations until the operator publishes reviewed metadata. Runtime checks add network reads before sensitive ceremonies and are cached only after successful verification. Live infrastructure and physical WebAuthn remain manual verification boundaries.

## Alternatives rejected

- Trusting a bundler’s submission response: it cannot prove on-chain success.
- Reading code hashes only from the same RPC at use time: this detects drift within a session but provides no independent deployment commitment.
- A hosted Loom recovery or submission coordinator: it would add avoidable availability, metadata and governance authority.
- Clearing malformed local storage wholesale: one corrupt record must never hide or destroy healthy wallets or recovery sessions.
