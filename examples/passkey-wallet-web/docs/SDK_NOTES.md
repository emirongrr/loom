# SDK notes from building the live wallet

Observations from wiring live balances and ETH transfers into this example
against `@loom/sdk` and `@loom/core`. Recorded so the gaps are visible; only the
first was fixed in this change.

## 0. Recovery validator provisioning (implemented and published)

Recovery needs a fresh, uninstalled validator because `RecoveryManager` replaces
the complete validator set and `P256Validator` keys cannot be reinitialized. A
generic hosted deploy endpoint would make a Loom-operated service appear
necessary even though provisioning itself needs no authority.

The core now includes an ownerless `P256RecoveryValidatorFactory`. The SDK
derives a child from the account, live recovery nonce, and initialization-data
hash; verifies the manifest-pinned factory code and fallback verifier; and
accepts the child only after its runtime code hash also matches. Core deployment
scripts include the factory, and a standalone script can add it to the existing
Sepolia deployment without changing account addresses or stored wallets.

The browser ceremony now creates and persists the new passkey draft, verifies
and publishes the permissionless child, rotates guardian salts, collects and
verifies portable approvals, proposes the recovery, resumes through the on-chain
delay, executes, and links the recovered credential to the existing Saved Wallet.
The deployment manifest publishes the verified Sepolia factory and code hashes.

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

## 3d. Generic deployment manifests do not model verifier code hashes

Guardian descriptors require a `verifierCodeHash`, and the SDK re-checks it against
the chain before use. This example now pins verifier and core runtime hashes in its
application deployment profile, but the SDK's generic deployment manifest schema
does not provide typed fields for those commitments. A future backward-compatible
schema version should model them so every consumer does not invent a parallel shape.

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

## 5. Recovery-to-basic SDK gaps found during the guardian lifecycle

### 5a. ABI integer types need runtime normalization

TypeScript assertions do not change viem's decoded runtime type. Small Solidity
integers such as the account's `uint48` scheduled-operation timestamp can arrive
as a JavaScript `number`, while the recovery UI and chain clock use `bigint`.
Mixing them crashed the pending guardian screen after setup.

Scheduled guardian and pending-recovery timestamps are now normalized at the SDK
boundary, with a regression test for the real numeric decode. The same rule should
be audited and centralized across the simplest account reads through nonce,
balance, freeze, session, migration, vault, and recovery readers: coerce and
bounds-check every ABI integer before exposing a public SDK result.

### 5b. Recovered-validator provisioning remains a P0 deployment dependency

The current example deployment has no trusted mechanism for provisioning a fresh
validator instance for recovered control. Reusing the installed validator is
forbidden. Keep `UNSUPPORTED_RECOVERED_VALIDATOR_PATH` fail-closed until decision
0013 is implemented by deployment tooling rather than adding an incidental UI
factory.

### 5c. Capability V2 still needs a complete consumer integration

The SDK can create and strictly parse individualized current/standby guardian
epochs. Guardian vault admission, live verifier-code checks, proof of possession,
passkey or EIP-1193 approval signing, standby activation, and V1-to-V2 delivery
still need one SDK-owned integration before the browser flow is end-to-end.

### 5d. Recovery coordination and cancellation should be first-class

Portable request/response schemas and pre-submit live-state revalidation now
exist. The SDK should additionally expose an immutable coordinator that rejects
duplicate or mismatched guardian responses, plus typed owner-cancel and
guardian-threshold-cancel preparation that uses the same revalidation policy.

### 5e. Local vault lifecycle needs an SDK boundary

Add explicit lock/unlock, WebAuthn-PRF key wrapping, account/chain/record/version
AAD, and encrypted export/import interfaces. PRF may wrap local vault keys but
must never derive guardian Merkle salts.

### 5f. Portable transport ergonomics

File, clipboard, encrypted fragment, and QR chunking adapters should remain
optional transport only. Add maximum-size and fragmentation tests covering
truncated, reordered, stale, duplicate, corrupt, and mixed healthy/corrupt
records. Integrity, signatures, proofs, live chain state, and independent human
code comparison remain the trust checks.

### 5g. Scheduled-operation provenance should be an SDK read model

The SDK can check `scheduledOperations(operationId)`, but it does not return the
matching `OperationScheduled` log provenance. The web example therefore has to
query account logs, match the event's operation id and ready time to account
storage at one fixed block, and carry the transaction hash itself. Promote this
into a transport-neutral SDK reader that returns the schedule transaction hash,
event block, verification block, ready time, and current live/cancelled state.
When historical log scans are unavailable it should accept discovery hints only
after re-reading the transaction receipt from the chain. Missing provenance must
never hide a live storage record, and stale events whose ready time no longer
matches storage must be rejected.

### 5h. Protected account creation needs one canonical SDK planner

The account contract supports a guardian root, threshold, and recovery module at
initialization, but the SDK has no single planner that validates this protected
creation shape, binds it into the configuration hash, returns the exact
counterfactual address, and carries the private salted roster to wallet storage.
The web example currently composes those pieces itself. A canonical helper should
also require deployment-pinned guardian verifier code hashes and accept explicit
proof-of-possession ceremony evidence; a live RPC code read alone must not become
the production trust anchor.

### 5i. Guardian onboarding needs an active-epoch delivery coordinator

Adding a guardian root on chain does not populate the guardian's local vault:
the private salted proof and individualized capability cannot be discovered from
public state. The example now rebuilds the active root, creates one V1 capability,
and delivers it as a local encrypted link/QR, but every application should not
reimplement that boundary. The SDK should expose a coordinator that admits only
an active, live-root-matching roster; creates one capability per guardian; binds
config and set versions; reports delivery/acceptance state without central
account linkage; and supports V2 current/standby rotation. Delivery remains an
optional transport, while encrypted file export is the provider-independent
fallback.

Vault admission should also be idempotent for a
`(chainId, protectedAccount, guardianAuthority)` identity: replaying a
capability for an already-active epoch must be rejected,
while a newer configuration or an expired/removed epoch may replace the visible
entry atomically. Mixed corrupt, expired, and healthy records must be isolated so
an unusable record can neither hide a healthy capability nor make a replay look
like a new protected account.

That identity must include the guardian authority, and admission/listing must be
scoped to the local signer context. Otherwise one browser-wide vault can expose
one guardian wallet's protected-account relationships in every other local
wallet, or incorrectly merge two independent guardians of the same account. The
SDK coordinator should provide this signer-to-capability match and reject an
invite before persistence when the open signer does not own its commitment.

### 5j. Prepared recovery should produce its portable request canonically

`prepareRecovery` verifies the live account, nonce, deployed validator, fresh
guardian root, and recovery digest, but applications still have to manually map
that result plus the current guardian state into `createRecoveryRequest`. Add an
SDK helper that accepts one `PreparedRecovery` and its already-inspected current
state, fixes the bounded request lifetime, and returns the canonical portable
request. It must reject state from another account/config/nonce and must never
put validator initialization data, passkey credential metadata, or the private
fresh guardian roster into the portable artifact; those remain encrypted,
device-local execution material.

### 5k. Guardian recovery approval needs one SDK-owned verifier/signing planner

The browser example currently has to reconstruct the old-validator hash from
live account state, bind a portable request back to `requestId` and the EIP-712
digest, verify the active capability proof and verifier bytecode, verify the
factory-derived validator address and runtime code, drive a direct P-256 guardian
passkey signature, and finally create a response. The SDK should expose this as
one fail-closed planner plus a signer adapter. It must accept only a request
matching the live account, config version, recovery nonce, guardian root,
threshold, and complete validator set; return a clear-signing review and exact
digest; then emit a response only after the configured verifier accepts the
signature. Transport and gas publication remain separate and optional.

Prepared recovery passkey material also needs a serializable SDK draft shape.
The factory call intentionally commits only `initDataHash`, so credential ID,
public key, origin binding, and full init data cannot be reconstructed from the
chain after a page reload. The SDK shape should contain no `bigint`, should be
strictly parsed, and should support matching the restored draft against the
live deterministic factory result before it is resumed.

### 5l. Recovery provisioner profiles must hash a factory child

The primary P-256 validator in an older account deployment can differ from the
child bytecode compiled into a later standalone recovery factory, even when
both use the same fallback verifier. Deployment tooling must therefore accept
and live-read a factory-provisioned child when building or verifying
`validatorRuntimeCodeHash`; it must not silently reuse the primary validator
module hash. Wallets should continue to fail closed by checking the pinned
factory address, deterministic child address, and deployed child runtime hash
before creating or accepting guardian approvals.

### 5m. P-256 recovery init data must remain callable calldata (fixed)

`LoomAccount.recoverConfiguration` forwards recovery initialization bytes to
the newly installed validator with a direct call. The SDK previously validated
only five selectorless ABI words, even though that payload could not invoke
`P256Validator.initialize`. Validation now requires the exact `initialize`
selector followed by its five canonical ABI words, checks the credential
bindings and allowed policy hook, and rejects selectorless or substituted
calldata. Existing browser recovery drafts already used this callable form and
remain valid.

### 5n. Loom-address guardians need a canonical P-256 resolver and signer

A Loom account's primary `P256Validator` intentionally rejects arbitrary
ERC-1271 hashes, so adding a Loom address through `ERC1271GuardianVerifier`
creates a guardian that cannot approve freeze or recovery digests. The browser
example now verifies that the address belongs to the deployment factory's
per-app registry, accepts only the manifest primary validator or a
runtime-hash-pinned recovery-validator child, checks the configured fallback
verifier, reads the account's active public key, and commits that key through
`P256GuardianVerifier`. The Loom address is discovery input only and is not
stored in the guardian leaf.

The SDK should own this resolution policy and the exact
`abi.encode(WebAuthnP256.PublicKey, WebAuthnP256.Signature)` encoder. It should
reject unregistered accounts, unknown validator bytecode, zero or ambiguous
keys, and fallback-verifier disagreement, and return a P-256 descriptor plus a
clear-signing adapter. Keeping these checks in one SDK implementation prevents
other wallets from repeating the ERC-1271 misconfiguration or subtly encoding
an incompatible WebAuthn signature.

### 5o. Guardian address admission should be account-type agnostic

Applications should not ask users to decide whether an address is an EOA, a
smart-contract account, or a Loom wallet. The SDK now exposes the canonical
address-backed signature envelope and descriptor, and rejects repeated key
commitments even when different kinds or verifiers are supplied. It should
also own the browser example's fail-closed resolver that checks the deployment
registry first and returns the exact descriptor and pinned verifier evidence.
RPC or registry failure must not fall back to an assumed type.

The SDK should keep the form address-only while resolving the verifier before
the guardian set is committed. It must check the Loom registry first, otherwise
read runtime code and pin either the ECDSA or ERC-1271 verifier and its code
hash. A canonical non-magic `isValidSignature` response confirms the interface;
an inconclusive/reverting probe must produce a user-visible warning, while a
contract that returns the magic value for the deliberately invalid probe must
be rejected as unsafe. The contract must not reclassify the address at approval
time. This keeps
the authority visible and immutable for the lifetime of the guardian leaf.
Counterfactual contract wallets must be deployed before setup-time detection;
RPC or registry failure must fail closed instead of guessing.
