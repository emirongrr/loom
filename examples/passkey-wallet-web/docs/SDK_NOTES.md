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

## 3c. The RPC state transport has no block-timestamp reader

`createGuardianRecoveryClient` accepts a `GuardianRecoveryStateTransport` with an
optional `getBlockTimestamp`, and uses it to decide whether a scheduled guardian
change or a pending recovery is still delaying or is ready. `createRpcStateTransport`
does not implement it, so the SDK's own transport leaves every delay in the
"unknown" state and a wallet must either guess from local clock time or wrap the
transport itself, as `src/features/security/guardianClient.ts` does. The RPC
transport should implement `getBlockTimestamp` (it already speaks JSON-RPC).

## 3d. Deployment manifests pin verifier addresses but not their code hashes

Guardian descriptors require a `verifierCodeHash`, and the SDK re-checks it against
the chain before use — but `public/sepolia.deployment.json` publishes only verifier
addresses. The wallet therefore reads the hash from the same chain it will later
verify against, which detects a verifier whose code changes between setup and use,
yet cannot detect a wrong verifier at setup time. Deployment manifests should pin
the expected runtime code hash alongside each verifier address.

## 3e. Guardian set membership has no persistence helper

Only the root and threshold are on chain, so a wallet that wants to add or remove
one guardian must keep the full descriptor set (with salts) itself to rebuild the
tree — see `src/storage/guardianRoster.ts`. Keeping identities off chain is the
design, but every wallet now re-implements the same encrypted roster, salt
rotation, and "this record belongs to another account" validation. An SDK-side
serialisation format for a guardian set (opaque, encrypted by the caller) would
make rosters portable between wallets, which matters because losing the roster
means losing the ability to edit the set.

## 3f. A guardian may hold no funded submitter

`submitFreeze` needs a submit transport. Freezing is permissionless, so anyone can
carry the call, but a guardian acting from a browser typically holds no funded key
for the account they protect — and for an ECDSA or ERC-1271 guardian there is no
in-page signer either. This example therefore prepares and verifies the freeze
against live state and then hands over the exact calldata for independent
submission. A documented "prepare here, submit anywhere" path (or a relay adapter
interface) would make this a first-class flow rather than a copy-paste step.

## 4. Account creation needs no privileged submitter (correcting the repo's own note)

`sponsor-server.mjs` and the previous `src/wallet.mjs` both stated that "the
factory fail-closes to `entryPoint.senderCreator()`, so no third-party bundler can
validate initCode", and that creation therefore has to go straight to
`EntryPoint.handleOps` from a funded submitter. That reasoning does not hold.

`LoomAccountFactory.createAccount` requires `msg.sender ==
entryPoint.senderCreator()`, which is exactly the path the EntryPoint itself uses
for factory calls — it blocks *direct* calls to the factory, not bundler-mediated
creation. And `LoomAccount.validateUserOp` forwards `missingAccountFunds` from the
account's own balance, so a counterfactual address that has been funded pays for
its own creation.

Verified against the public Pimlico bundler on Sepolia: it lists this EntryPoint
among its supported ones, and `eth_estimateUserOperationGas` on a creation
operation for an unfunded counterfactual account fails with `AA21 didn't pay
prefund` — that is, it simulated the factory call and the account's deployment
successfully and stopped only at the prefund. A funded account therefore creates
itself through an ordinary bundler, which is what
`src/features/wallet/activate.ts` now does.

A sponsor relay remains useful for onboarding an account that holds nothing, which
is what the enterprise example demonstrates. It is not a requirement for creation.

Two SDK edges made this harder than it should be:

- **`sendTransaction` cannot express a call-less operation.** `prepareCalls`
  rejects an empty array ("calls must be a non-empty array"), but account creation
  is exactly an operation with no calls. The flow has to compose
  `prepareDeployAccount` → `fillUserOperation` → sign → `transport.sendUserOperation`
  by hand, re-implementing what `sendTransaction` already does, because that
  convenience path is closed to deployment.
- **The envelope builder turns `initCode` into call data.**
  `prepareUserOperationEnvelope` resolves call data as
  `input.callData ?? intent.callData ?? intent.initCode ?? encodeCalls(...)`, so a
  deployment intent silently yields `callData === initCode` — the account would
  execute its own creation call as its first action. Callers must pin
  `callData: "0x"`; nothing warns them. Deployment intents should not fall through
  to `initCode` for call data.

The remaining gap is smaller but real: **the creation configuration has to be
reconstructed by the caller.** An account address is a commitment to a
configuration the wallet must rebuild from its own stored inputs, with no SDK
helper and nothing on chain to compare against before deployment. This example
rebuilds it and refuses to proceed unless it re-derives the account's own address —
otherwise a subtly wrong configuration would create a different account under the
user's name. `prepareDeployAccount` takes an already-built `initCode`, so it does
not close this.
