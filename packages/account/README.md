# Loom Account Package

`@loom/account` contains local lifecycle builders for wallet clients and SDK
integrators. It does not publish transactions, choose RPCs, choose bundlers,
select paymasters, or contact Loom infrastructure.

The package exists so independent wallet clients can construct the same
high-risk account actions with explicit authority metadata before simulation,
clear signing, signing, and publication.

## Current surface

- Account deployment intent.
- Granular session grant and revoke intent.
- Visible delayed recovery proposal, cancellation, and execution intent.
- Visible delayed migration schedule, cancellation, and execution intent with
  destination code hash binding.
- Visible delayed vault withdrawal schedule, cancellation, and execution
  intent.
- Explicit optional paymaster policy intent.

## Design rules

- No default RPC, bundler, paymaster, relayer, indexer, or recovery service.
- High-risk lifecycle actions carry delay and cancellation metadata.
- Completion intents bind the exact pending operation ID, version, nonce, hash,
  or validator set needed to avoid ambiguous finalization.
- Paymaster use is always explicit and bounded by token, amount, and expiry.
- Builders return data. Wallet clients remain responsible for simulation,
  signing, publishing, and user explanation.
- The package must remain usable by third-party clients without Loom-operated
  infrastructure.

## Non-goals

- No UI.
- No transaction submission.
- No hosted account registry.
- No private scanning or privacy protocol implementation. Privacy execution
  belongs in `@loom/privacy`.
