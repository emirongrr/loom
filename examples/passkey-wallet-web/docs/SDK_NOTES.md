# SDK notes from building the live wallet

Observations from wiring live balances and ETH transfers into this example
against `@loom/sdk` and `@loom/core`. Recorded so the gaps are visible; only the
first was fixed in this change.

## 1. `@loom/core` compiled JSON schemas at import time (fixed)

`packages/core/src/manifest.ts` built its ajv validator at module load
(`const validate = ajv.compile(...)`). ajv generates validators with
`new Function`, which a strict `script-src` Content-Security-Policy without
`unsafe-eval` forbids. Because the `@loom/core` barrel re-exports `manifest`,
simply importing `@loom/core` — or anything that depends on it, including
`@loom/sdk` — threw under this wallet's `script-src 'self'` CSP, which is why the
earlier revision of this example could not import the SDK at runtime at all.

Fixed by compiling the validator lazily on first use. A regression test
(`packages/core/test/manifest-lazy.test.mjs`) pins the contract. Consider going
further and shipping precompiled ("standalone") ajv validators so no runtime code
generation is needed anywhere.

## 2. No first-class balance / asset read helpers

The SDK exposes state transports (`createRpcStateTransport`) and
`readAccountSafetyState`, but no helper for a plain ETH balance, an ERC-20
balance, or token/NFT discovery. This example uses `viem` plus the configured
explorer's index directly (`src/features/wallet/assets.ts`). A small
`readNativeBalance` / `readErc20Balance` on the SDK client would remove that
direct `viem` dependency from consumers.

## 2b. No transfer-call builders

Moving a fungible token or a collectible means hand-encoding
`transfer(address,uint256)` and `safeTransferFrom(...)` in the consumer
(`src/features/wallet/transfers.ts`). Since the account's execution surface
already takes `{target, value, data}` calls, small audited encoders for the
common ERC-20/721/1155 transfers would keep every wallet from rewriting them —
and from getting the ERC-1155 argument order subtly wrong.

## 3. No default/public transport presets

By design the SDK selects no default RPC or bundler (walkaway). For a product
wallet that still means every consumer hardcodes endpoint strings. A clearly
optional, opt-in preset (e.g. `publicSepolia()`) would keep the walkaway
guarantee while removing copy-pasted endpoint literals. This example keeps the
defaults local in `src/config/network.ts`.

## 3b. No history/indexer abstraction

Account history comes from the configured explorer's index
(`src/features/wallet/activity.ts`), parsed in the consumer. The SDK has no
notion of an indexer adapter, so every wallet re-implements the same work: status
and finality interpretation, merging native transactions with token transfer
logs, and cursor pagination across two independently paginated sources whose
pages interleave by time (so a later page can contain entries newer than an
earlier page's tail, and the merged list must be de-duplicated by transaction
hash and re-sorted rather than appended). A thin `LoomHistoryTransport` interface
(with the explorer as one implementation) would let wallets swap in a self-hosted
indexer or a light-client-backed source without changing UI code, and keep "an
indexer is not a trust anchor" a structural property rather than a comment.

## 4. Account deployment still needs a direct submitter

`sendTransaction` through a public bundler works for an already-deployed account.
A counterfactual account's first operation carries `initCode`, and this factory
fail-closes to the EntryPoint's `senderCreator`, so a third-party bundler cannot
validate it. The example reads deployment status and guides the user to fund the
address; a documented SDK path for "deploy-then-send in one funded submission"
would make first-use flows smoother.
