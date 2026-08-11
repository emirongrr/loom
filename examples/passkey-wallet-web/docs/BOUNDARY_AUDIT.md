# Passkey wallet boundary audit

Baseline: `68ba41c697c0acd6b4bbac98c40ec7ca85fccfb9` (`feat(example): a full-featured passkey wallet on Loom`).

> **Status: closed.** The refactor this audit specifies has landed —
> `src/wallet.mjs` and the inline `index.html` script are gone, and the example is
> organised into `src/features`, `src/storage`, and `src/transports`. See
> [`MIGRATION.md`](MIGRATION.md).
>
> Everything below describes the **baseline commit** and the plan as written
> against it. It is kept as the reasoning behind the current structure, not as a
> description of the code today. Where the plan and the tree disagree — it names
> `src/loom` and `server`, which the example does not have — the tree is
> authoritative.

## Problem and acceptance condition

The baseline demonstrates real account operations, but its application layer is also a second protocol implementation. A safe reference wallet must leave guardian commitments, proofs, typed-data digests, approval ordering, recovery calldata, scheduled-operation identity, account inspection, and UserOperation preparation to Loom packages. React should only coordinate typed domain states and injected I/O. The measurable boundary condition is that no reusable guardian Merkle or recovery algorithm remains under `examples/passkey-wallet-web` and normal flows never exchange raw digests or signatures.

The affected authority boundary is complete account control: a recovery proposal replaces every validator and rotates the guardian root. An encoding, stale-state, verifier-binding, or UI review error can therefore transfer control or make recovery unavailable.

## Baseline evidence

- `src/wallet.mjs` is 974 lines and mixes package composition, protocol construction, RPC reads, browser randomness, asset discovery, and application helpers.
- `index.html` is about 2,700 lines and combines presentation, state, DOM mutation, WebAuthn, storage, RPC/relay calls, guardian export/import, and recovery approval collection in an inline executable script.
- `sponsor-server.mjs` exposes permissive cross-origin, unauthenticated endpoints and deploys a complete `P256Validator` for each recovery.
- `test/wallet.test.mjs` contains seven onboarding/session tests but no guardian, recovery, storage, transport, or browser tests.
- `@loom/guardian` already contains canonical leaf/tree/proof code and a differential test, but it is Node-oriented and is not a browser-safe recovery client. The baseline duplicates it instead of consuming it.
- `@loom/core` exports account, factory, EntryPoint, and P-256 validator ABIs, but not the supported account recovery/freeze and `RecoveryManager` ABIs.
- The canonical manifest type records generic modules but the example maintains a second unvalidated projection with guardian verifier fields and no runtime code hashes.

## Baseline responsibility map

| Baseline function or area | Current behavior | Correct owner |
| --- | --- | --- |
| `buildAccountConfig`, `saltFor`, `deriveWallet`, `registerPasskeyAccount`, `reconnectPasskeyAccount`, `reconnectRecoveredAccount` | Counterfactual passkey account handle and recovery reconnection | `@loom/sdk` account API plus `@loom/passkey`; the example supplies labels and persistence |
| `walletSigner` | Adapts WebAuthn to Loom signatures | `@loom/passkey` composition; thin application wiring is acceptable |
| `walletClient` | Binds signer and injected transports | Application-domain composition over `@loom/sdk` |
| `prepareDeployOperation`, `prepareOperation` | Rebuilds, hashes, fills, and signs UserOperations with fixed gas defaults | `@loom/sdk`; the app selects payer and submitter |
| `sponsorCalls` | EntryPoint sponsorship calldata | SDK or explicit infrastructure adapter, never UI |
| `validateGuardians` | Address normalization, code detection, verifier selection, RPC history heuristics | SDK recovery candidate inspection; heuristics belong in application review |
| `buildGuardianSet`, `proofForLeaf` | Verifier code-hash binding, commitments, canonical sorting, tree, proofs, random salt | `@loom/sdk/recovery`; `@loom/guardian` becomes a compatibility/ceremony layer |
| `guardianChangeCalls`, `readGuardianChange` | Config calldata, schedule ID, readiness | `@loom/sdk/recovery` chain client |
| `readValidators` | Complete installed-validator discovery | `@loom/sdk/recovery` chain client |
| `prepareRecoveryRequest` | Validator init data, root rotation, validator-set hash, nonce/config reads, digest | SDK recovery client; passkey initialization encoding may compose `@loom/passkey`/`@loom/core` |
| `assembleRecoveryApprovals` | Rebuilds old tree and sorts Solidity tuples | `@loom/sdk/recovery` |
| `recoveryProposeCall`, `recoveryExecuteCall`, `readPendingRecovery` | ABI tuples, calldata, state decoding | `@loom/sdk/recovery` |
| `prepareFreeze`, `verifyGuardianSignature`, `assembleGuardianApprovals` | Proof, freeze digest, signature check, tuple aggregation | `@loom/sdk/recovery`; verifier-specific signing remains injected |
| `readSafety` | Composes an SDK state read | Application-domain composition; no protocol duplication |
| `sendViaBundler` | Chooses a replaceable route | Transport/infrastructure adapter |
| `unfreezeCall`, `revokeAllowanceCall`, `transferCall`, `parseAmount`, `formatAmount` | Application actions using supported ABI shapes | SDK/core for supported account calls; application for asset display/amount input |
| `readAllowance`, `discoverAssets`, `readAsset` | RPC and explorer I/O | Transport/infrastructure adapters; explorer output is untrusted discovery only |
| `grantSession`, `revokeSession` | Thin SDK calls | Application-domain composition |
| inline WebAuthn helpers | Browser credential creation/assertion | `@loom/passkey` browser adapter |
| inline account/guardian/recovery state | Scattered variables, DOM handlers, and `localStorage` | Typed feature reducers and storage adapters |
| `sponsor-server.mjs`, `dev.mjs`, `sponsor-deploy.mjs` | Development relay, static server, funded submitter | Development-only tooling, explicitly outside the sovereign path |
| `tools/e2e/devnet-social-recovery.mjs` | Contract-backed lifecycle proof | Development-only evidence tooling |

## Duplicated protocol logic and missing primitives

The example independently implements guardian leaves, sorted-pair Merkle trees, proofs, verifier runtime code hashes, ECDSA/ERC-1271 detection, random salts, freeze EIP-712, recovery proposal digests (by RPC), approval ordering, config scheduling, operation IDs, validator enumeration, validator-set hashes, recovery calldata, and UserOperation hashing/signing. These are consensus-adjacent algorithms, not example-domain logic.

Required public surface:

```ts
import {
  createGuardianLeaf,
  createGuardianSet,
  createGuardianProof,
  verifyGuardianProof,
  createGuardianInvite,
  parseGuardianInvite,
  validateGuardianInvite,
  assembleGuardianApprovals,
  createGuardianRecoveryClient
} from "@loom/sdk/recovery";
```

The pure surface accepts explicit verifier code hashes and an injected randomness source. The chain client accepts `LoomStateReadTransport` and a small submission transport, validates chain/deployment bindings, and returns typed domain states/errors and clear-signing reviews. It owns supported calldata and digest construction. Applications own aliases, navigation, confirmation, local activity, and selection of replaceable adapters.

## Unsafe or misleading shortcuts

1. The generic `/deploy-validator` endpoint spends a backend key to deploy arbitrary per-recovery instances. It is unauthenticated, rate-unlimited, provider-dependent, and not a production recovery architecture.
2. `access-control-allow-origin: *` is applied to every relay response without an explicit production origin policy.
3. Guardian invitations contain the full set and are exported as plaintext JSON. Every recipient learns the owner's complete guardian graph.
4. The UI calls a generated invite "delivered", conflating creation with transport receipt.
5. Recovery uses raw digest and signature text fields as its normal flow and sends the full request to every guardian.
6. Guardian records and account handles are scattered through plaintext `localStorage`; relationship metadata has no storage boundary or authenticated encryption.
7. Inline script prevents a strict CSP without `'unsafe-inline'`; dynamic `innerHTML` expands XSS review scope.
8. Ad-hoc ABIs and raw RPC errors are embedded in application code. No typed recovery error model exists.
9. Fixed UserOperation gas defaults can overpay or fail despite available estimation transports.
10. The example manifest omits the deployed P-256 guardian verifier and runtime code-hash evidence, so the recommended unlinkable guardian path is not first-class.
11. Browser device time is used in some status decisions; chain time must govern protocol readiness.
12. Explorer discovery leaks account queries and can poison metadata; the baseline re-reads balances but does not isolate or clearly consent to this privacy surface.

## Target boundaries and state

- `@loom/core`: generated ABIs, byte/address primitives, canonical manifest validation. No UX or network policy.
- `@loom/passkey`: credential creation/assertion and P-256 signature encoding. No recovery orchestration.
- `@loom/sdk/recovery`: deterministic guardian/invite/approval primitives and chain-bound recovery/freeze/configuration client.
- `@loom/guardian`: Node ceremony, encrypted backup, and compatibility exports built on the SDK primitives; no second tree algorithm.
- `src/loom`: account/passkey client composition and deployment normalization only.
- `src/storage`: versioned account store and encrypted IndexedDB `GuardianVault`.
- `src/transports`: RPC/bundler/relay/simulation/invitation/mailbox adapters with no authority.
- `src/features`: plain discriminated-union reducers and application use cases.
- React components: render state, collect labeled inputs, and dispatch typed actions only.
- `server`: development-only static/relay/mailbox processes with size, origin, expiry, replay, and rate limits.

Primary reducers cover deployment, guardian onboarding, guardian configuration, freeze, recovery, and transaction lifecycle. Actions are derived from state; errors retain developer detail but present actionable safe messages.

## Compatibility and migration risks

- Existing plaintext, full-set guardian exports remain importable only through a labeled legacy migration path; they must not be generated by default.
- Existing derived account handles need a versioned migration that preserves original guardian root, threshold, recovery module, RP ID, origin, salt inputs, and address.
- Recovered handles must preserve the explicit account address and distinguish themselves from deterministically derived handles.
- Existing Sepolia deployments may not advertise a compatible uninstalled recovery validator. The SDK must return `UNSUPPORTED_RECOVERED_VALIDATOR_PATH`, not silently call a Loom service.
- Moving browser imports to `@loom/sdk/recovery` changes package export maps and requires build/type/release fixture updates.
- Invite validation is fail-closed: unknown critical fields, wrong chain/account/root/config version, expiry, and bad proof become breaking rejections for malformed legacy files.

## Contract decisions

No production contract change is justified in this implementation. `RecoveryManager` already enforces complete sorted validator replacement, fresh guardian root, config-version binding, nonce replay protection, delay, cancellation, expiry, and permissionless execution. Weakening its `newValidator`-not-installed check or allowing a generic server to provision validators would expand authority.

The preferred future design is a permissionless deterministic validator factory with pinned creation/runtime code hashes and a counterfactual address API, recorded in ADR 0013. It requires a separate contract, formal, gas, deployment, and audit-scope change. A recoverable-validator interface is not added because it introduces a new key-rotation caller boundary inside every validator. Multi-P256 is not treated as recovery merely because it can manage several credentials, and a finite predeployed family complicates manifests and multi-validator exhaustion.

## Privacy data flow and invariants

On chain, the account continues to expose only root, threshold, config version, freeze state, and pending recovery parameters. Individual guardian capabilities are created locally, encrypted before optional relay storage, and stored only after explicit acceptance in the guardian's local vault. A capability contains one guardian's commitment and proof, never the whole set.

Observers include the chain, RPC, bundler/submitter, optional mailbox, browser origin, and anyone receiving a link. The chain learns a guardian's verifier, commitment, salt, proof, and signature only when that guardian acts. ECDSA/ERC-1271 action can reveal a linkable address. A dedicated P-256 guardian reveals a recovery-specific public credential when used but not a primary Ethereum identity. Execution-time approvals are not anonymous; ZK/threshold-signature alternatives remain future research in ADR 0014.

Security invariants to preserve and test:

- authority cannot expand without the configured threshold and delay;
- duplicate guardians/approvals and unsorted caller input cannot create duplicate authority;
- all digests bind chain, account, current config version, nonce, and exact action;
- stale capabilities and approvals fail after guardian/config rotation;
- failed verification/submission does not mutate local accepted state or on-chain state;
- one guardian can freeze but cannot transfer or permanently veto recovery;
- recovery replaces the complete validator set, preserves the account address, invalidates old credentials, and rotates the guardian root;
- relays, bundlers, RPCs, explorers, storage, and mailbox transports can disappear without removing the direct/offline path.

## Verification baseline

- `npm.cmd ci`: passed; 54 packages installed, zero reported vulnerabilities.
- `npm.cmd run verify:quick`: progressed through core, SDK, passkey, guardian, privacy, documentation, and deployment checks, then failed on the pre-existing Windows-only CLI process termination assertion at `packages/cli/test/devnet-cli.test.mjs:142`.

