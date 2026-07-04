# WalletBeat Stage 2 Acceptance Matrix

Source of truth: WalletBeat's public `beta` branch. Review this document before
every Loom release because the methodology evolves.

This repository is the on-chain account/authorization layer plus a non-mandatory
developer SDK (`packages/*`). It is not, and does not aim to be, the wallet
client (see `ARCHITECTURE.md` System Boundary). The three sections below separate
what the **contracts** guarantee, what the **SDK** already provides as optional
client enablers, and what genuinely remains **client/operational** work.

## Contract guarantees

| WalletBeat area | Loom contract guarantee | Evidence |
|---|---|---|
| Account abstraction | ERC-4337 validation and open validator selection | `LoomAccount.validateUserOp` |
| Atomic batching | Batch reverts entirely when any subcall fails | `LoomAccount.execute` |
| Account unruggability | Non-upgradeable immutable proxy, no admin, no mutable implementation, and no developer recovery authority | Proxy, account, and factory constructors |
| Account portability | ERC-1271 and ERC-4337; Loom-specific limited module profile | Public interfaces |
| Account recovery | Visible guardian-threshold proposal, delay, cancellation, expiry, and atomic validator/guardian rotation | `RecoveryManager`, account recovery module |
| Permissions management | Exact-call and granular enumerable revocable session permissions plus allowance revoke | `ExactCallSessionValidator`, `GranularSessionValidator`, `revokeTokenAllowance` |
| Impact mitigation | Low-risk policy limits, vault delays, timelocks, and freeze | `PolicyHook`, `VaultHook`, scheduled calls, `freeze` |
| Cross-chain readiness | L1-rooted identity config plus proof-gated optional sync; no bridge or service authority | `LoomKeystore`, `KeystoreSyncRecoveryModule`, `configHash`, `configVersion` |

## SDK enablers (optional developer library)

These are provided by the SDK under `packages/`. They are **non-mandatory and
stateless**: a wallet client (or a competing library) can ignore them, and none
of them becomes required for account control (`ARCHITECTURE.md` Authority
Layers). They cover the account-facing logic of several WalletBeat criteria; the
client still owns endpoint wiring, a verifying node, UX, and RPC surface.

| WalletBeat area | SDK enabler (client still owns) | Evidence |
|---|---|---|
| Custom node endpoints, no default provider | State reads and bundler transport require caller-supplied endpoints; there is no Loom default fallback | `createRpcStateTransport`, `createBundlerTransport` (`packages/sdk/src/index.js:482`, `:394`) |
| ERC-5792 wallet calls + atomic capability reporting | `wallet_sendCalls` preparation and `wallet_getCapabilities` atomic status; the client exposes the RPC method | `prepareWalletSendCalls`, `walletGetCapabilities` (`packages/sdk/src/index.js:698`, `:679`) |
| Clear signing / calldata interpretation of Loom operations | Lifecycle-intent explanation (risk, delay, guardian, metadata) and typed lifecycle call encoders; the client renders it and simulates arbitrary calls | `explainLifecycleIntent` (`packages/sdk/src/index.js:947`), `encoders`/`createLifecycleCallEncoder` (`packages/sdk/src/index.js:121`) |
| Independent bundler path | Explicit bundler transport with no hidden default | `createBundlerTransport` (`packages/sdk/src/index.js:394`) |
| Passkey authentication | WebAuthn passkey signer seam over a caller-supplied `signChallenge` | `createPasskeySigner` (`packages/sdk/src/index.js:764`) |
| viem interoperability | Prepared calls shaped for viem without a default provider call | `toViemCalls` (`packages/sdk/src/index.js:664`) |

## Required wallet/client work

The contracts and SDK alone cannot earn a WalletBeat software-wallet stage. The
following remain genuinely client- or operations-owned and are out of this
repository's scope:

- Integrate an Ethereum L1 light client and verify chain data. (The SDK exposes
  a read-transport seam via `createRpcStateTransport`, but verification is the
  client's.)
- Build and broadcast permissionless L2 force-withdrawals through L1.
- Provide transaction **simulation** (state-diff/preview) and ABI decoding
  beyond Loom's own lifecycle calls, and render clear-signing to the user.
- Expose ERC-5792 through an actual wallet RPC provider surface (the SDK provides
  the preparation and capability logic above).
- Support chain-specific address resolution.
- Avoid correlating wallet addresses with user identity or with each other in
  client-side deployment and usage.
- Keep native-gas and independent-bundler paths available when offering an
  optional token-fee paymaster.
- Publish all source under a FOSS license with a reproducible, reviewed release
  process.
- Maintain current audits, a funded bug bounty, and transparent fees/funding.

## Release gate

For every release:

1. Re-run the walkaway test and cypherpunk contract-review questions.
2. Compare WalletBeat `beta` stage definitions and the 1TS security benchmark
   against this matrix.
3. Re-run unit, fuzz, invariant, static-analysis, and bytecode-reproducibility
   checks.
4. Re-verify the SDK-enabler evidence links still resolve and that no enabler has
   silently become a mandatory dependency or acquired a default provider.
5. Document any changed criterion and whether it is contract, SDK, or client
   owned.
6. Prefer the stronger security guarantee when a criterion conflicts with
   account safety.
