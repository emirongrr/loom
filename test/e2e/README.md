# Loom E2E Tests

E2E tests answer a different question than Solidity unit or integration tests:

> Can a wallet developer use the Loom SDK to run a user-facing wallet flow from
> preparation, through signing and broadcast, to receipt or safety-state review?

These tests are Node/TypeScript-side because they exercise SDK/client behavior,
transport adapters, signer boundaries, clear-signing review, capability
reporting, receipt waiting, and walkaway operation. They do not replace
contract integration tests.

## Current Profile

The default PR-safe E2E profile uses:

- `createLoomClient`
- fixture passkey signer boundary
- caller-supplied in-memory bundler transport
- caller-supplied state transport
- no default RPC, bundler, paymaster, recovery coordinator, or provider

This is intentionally deterministic and fast. The in-memory transport is a
test boundary for the external bundler. It must not be used to claim live
bundler or testnet readiness.

## Mock Policy

Allowed in default E2E:

- in-memory bundler transport, because the SDK does not own bundler behavior;
- fixture passkey signer, because real device/browser fixture evidence is
  covered separately under `fixtures/webauthn` and Solidity evidence tests;
- state transport fixtures, because the claim is SDK decoding and fail-closed
  state presentation.

Not allowed for production claims:

- replacing Loom SDK logic with test doubles;
- pretending an in-memory transport is a live bundler;
- claiming on-chain execution without `EntryPoint.handleOps` or live-chain
  evidence;
- hidden default RPC, bundler, paymaster, or recovery service.

## Future Profiles

The next E2E layers should be separate scripts/jobs:

- local Anvil deployment with deployed Loom contracts and EntryPoint;
- local ERC-4337 bundler RPC path;
- fork/testnet rehearsal pinned to block/deployment manifest;
- two independent live bundler qualification;
- browser/hardware passkey rehearsal.

Keep these heavier profiles out of default PR CI until they are deterministic
and have explicit evidence outputs.

## Commands

```sh
npm run test:e2e
```

Full verification should include this command once the E2E profile remains
stable and fast.
