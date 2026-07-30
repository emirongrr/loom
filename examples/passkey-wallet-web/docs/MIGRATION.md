# Migration from the monolithic example

The previous `src/wallet.mjs` mixed application state with reusable guardian and recovery algorithms. It has been removed.

## Application changes

- Import guardian/recovery operations from `@loom/sdk/recovery` rather than constructing leaves, Merkle layers, proofs, digests, Solidity tuples, or calldata locally.
- Store versioned public account handles through `AccountStore`; do not persist private passkey material.
- Store accepted guardian capabilities through `GuardianVault`; do not scatter relationship metadata across `localStorage`.
- Inject invitation, mailbox, state, simulation, and submission transports. A Loom-hosted provider is never required.
- Route all authority-bearing actions through the shared `TransactionReview` model.

## Invite compatibility

Only version 1 individualized invites are accepted. Parsers reject unknown critical fields, stale expiry/root/config version, chain/account mismatch, malformed commitments, or invalid proofs. The old full-set JSON bundle is an offline artifact, not a normal invitation; operators should regenerate individualized capabilities and complete guardian acceptance before activation.

## Validator provisioning

The development `/deploy-validator` endpoint was removed. Existing deployed accounts are unchanged. Until the permissionless deterministic factory in ADR-0013 is implemented and audited, applications must supply an explicitly reviewed recovered-validator path and must fail with `UNSUPPORTED_RECOVERED_VALIDATOR_PATH` when none is configured.

## Package exports

Generated recovery/verifier ABIs are available from `@loom/core/abi`. Browser applications should prefer that side-effect-free subpath instead of importing ABI values through the root entry point. Recovery APIs are available from `@loom/sdk/recovery`.
