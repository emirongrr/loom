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

## 2. No first-class balance / native-asset read helper

The SDK exposes state transports (`createRpcStateTransport`) and
`readAccountSafetyState`, but no helper for a plain ETH balance or ERC-20 read.
This example uses `viem` directly (`readAccountBalance` in
`src/features/wallet/accountClient.ts`). A small `readNativeBalance` /
`readErc20Balance` on the SDK client would remove that direct `viem` dependency
from consumers.

## 3. No default/public transport presets

By design the SDK selects no default RPC or bundler (walkaway). For a product
wallet that still means every consumer hardcodes endpoint strings. A clearly
optional, opt-in preset (e.g. `publicSepolia()`) would keep the walkaway
guarantee while removing copy-pasted endpoint literals. This example keeps the
defaults local in `src/config/network.ts`.

## 4. Account deployment still needs a direct submitter

`sendTransaction` through a public bundler works for an already-deployed account.
A counterfactual account's first operation carries `initCode`, and this factory
fail-closes to the EntryPoint's `senderCreator`, so a third-party bundler cannot
validate it. The example reads deployment status and guides the user to fund the
address; a documented SDK path for "deploy-then-send in one funded submission"
would make first-use flows smoother.
