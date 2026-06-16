# Verified Wallet Client

The Loom account contracts do not trust an RPC provider for authority, but a
wallet UI can still mislead users if it displays unverified balances, nonces,
recovery state, guardian roots, vault limits, or validator state. Phase 10
defines the client-side verification architecture needed for Loom to pass the
walkaway test at the wallet layer.

## Goal

Reduce RPC providers to transport. A Loom wallet should verify security-
critical state before presenting it as fact or using it to construct an
operation.

```text
RPC provider
    |
    v
Light client
    |
    v
Verification layer
    |
    v
Wallet UI and SDK
```

## Candidate clients

- Helios is the first practical candidate for Ethereum L1 and selected L2
  networks. It turns an untrusted execution RPC into a local verified RPC, can
  run with very small storage, and targets wallet/mobile/WASM embedding.
- Future rollup light clients are required for chain-specific L2 guarantees.
  Until a rollup has a reviewed verifier path, the wallet must label that
  network as partially verified and state the remaining sequencer, RPC,
  bridge, or proof assumptions.

Helios still needs a trusted weak-subjectivity checkpoint and an execution RPC
that serves required proof data. Those assumptions must be visible and
replaceable by the user.

## Verified state

| State | Source | Verification requirement | Failure behavior |
|---|---|---|---|
| Native balance | Account state proof | Verify against finalized or explicitly labeled head | Show unknown; do not build amount-sensitive sends |
| ERC-20 balance | Storage proof for token balance slot | Verify token contract code and storage proof | Show unverified token state |
| Account nonce | EntryPoint/account state | Verify account nonce source used for operation construction | Refuse signing if nonce source is unverified |
| Recovery status | `RecoveryManager.pendingRecoveries` | Verify module address, storage proof, ready/expiry timestamps | Warn and block high-risk signing if unknown |
| Guardian root | Account storage | Verify `guardianRoot`, threshold, and `configVersion` | Refuse recovery/config UX claims |
| Vault state | `VaultHook` storage | Verify policy, daily spend, pending withdrawals, expiry | Treat vault liquidity as unknown |
| Validator state | Account/module storage | Verify installed validators and module-specific config | Refuse to claim a credential can sign |
| L1 keystore root | Ethereum L1 state | Verify `LoomKeystore` identity version and roots | Refuse cross-chain sync claims |
| L2 sync state | L2 account/module storage plus L1 proof status | Verify local pending sync and target verifier assumptions | Show local-only state until proof path is valid |

## Architecture

```text
Ethereum L1
    |
    |-- LoomKeystore
    |   |-- validatorRoot
    |   |-- guardianRoot
    |   |-- appAccountRoot
    |   `-- version
    |
    |-- Recovery network
    `-- Identity layer

L2 ecosystem
    |
    |-- Loom account
    |-- Loom vault
    |-- App accounts
    |-- Uniswap identity
    |-- Aave identity
    |-- Farcaster identity
    `-- Merchant identity

Privacy layers
    |
    |-- Private scanning layer
    |-- Stealth receive layer
    |-- Railgun shielded-pool adapter
    |-- Aztec private-execution adapter
    `-- Future privacy pool adapters

Verified wallet client
    |
    |-- Light client
    |-- Scanning engine
    |-- Recovery coordinator
    `-- SDK stack
```

## Privacy rules

- Verification must not require sending the user's full account graph to one
  RPC, indexer, relay, or Loom service.
- The scanning engine should support per-application identities, stealth
  addresses, and private-note discovery without central account correlation.
- Kohaku is the target privacy client dependency: the wallet should use
  Kohaku's plugin and provider model directly while moving toward local
  scanning, private state queries, and replaceable transports so RPCs and
  indexers become convenience layers instead of privacy authorities.
- Kohaku Railgun flows require account creation, indexer synchronization,
  shielded address discovery, shielding, private transfer, balance reads, and
  unshielding. The verified wallet client must label which of those reads are
  verified, which are locally indexed, and which depend on remote services.
- Viewing keys and scanning secrets remain local. If the user exports them,
  the wallet must label the export as account-graph disclosure.
- L1 roots improve portability but can also create correlation. Clients should
  let users maintain separate roots for contexts that should not be linked.
- Railgun and Aztec integrations belong behind the privacy adapter boundary in
  `docs/design/privacy-adapters.md`. They must not become mandatory account
  infrastructure or a hidden source of account liveness.

## SDK acceptance criteria

A future Loom SDK must expose:

- `Verified<T>` and `Unverified<T>` state types so UI code cannot silently
  downgrade proof requirements.
- Chain-specific verification profiles describing light-client source,
  finality, proof format, checkpoint source, and unsupported state.
- A state query API for balances, nonces, recovery, guardians, vaults,
  validators, and keystore roots.
- A fallback mode that can operate from a user-provided RPC or local node.
- A privacy budget model for every remote query batch.
- Privacy adapter interfaces for local-first scanning, shielded pools, private
  execution, stealth receive flows, scoped viewing keys, and metadata-budget
  reporting.
- Clear failure states: unknown, stale, unverifiable, inconsistent, and
  verified.

## Non-goals

- The contracts do not embed Helios, run a light client, or verify arbitrary
  wallet UI state.
- The contracts do not embed Railgun, Aztec, stealth-address scanning,
  privacy-pool logic, relayers, provers, or viewing-key storage.
- The repo does not claim a production verified wallet until a client
  implementation exists and has been tested across target networks.
- Rollup light-client support must be evaluated per network. A single generic
  L2 RPC check is not enough for sovereignty claims.

## End state

A Loom user should be able to authenticate with passkeys, recover socially,
store long-term funds in vaults, use separate identities across apps, receive
through stealth addresses, transfer through privacy systems, verify chain
state without trusting a single RPC provider, migrate without permission, and
operate independently of any single company.
