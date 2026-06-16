# Kohaku Privacy Integration

Loom's privacy client layer should use the upstream Kohaku project directly.
Kohaku provides privacy-first tooling for Ethereum, including a standardized
plugin interface, provider abstraction, Railgun support, and privacy-pools
support.

This document defines how the Loom SDK binds to Kohaku for Railgun, privacy
pools, provider abstraction, and future private execution systems. The
boundary is deliberately outside the immutable account core.

## Upstream packages

Loom's future SDK/client should bind to these Kohaku packages:

| Package | Loom use |
|---|---|
| `@kohaku-eth/plugins` | Primary private transaction plugin interface |
| `@kohaku-eth/provider` | Replaceable provider layer for ethers, viem, Helios, Colibri, and raw transports |
| `@kohaku-eth/railgun` | Railgun shielded-pool integration |
| `@kohaku-eth/privacy-pools` | Privacy-pools integration and future private withdrawal work |
| `@kohaku-eth/tornado-cash` | SDK-accessible Kohaku shielded-pool compatibility surface |
| `packages/pq-account` | Source-level account-security tooling and future migration target |
| `@a16z/helios` | Verified RPC/light-client candidate for private reads |
| Colibri-compatible providers | Optional stateless provider path for private protocol indexers |

The Loom privacy package declares published Kohaku packages as direct SDK
dependencies and records source-only Kohaku packages in
`packages/privacy/kohaku-stack.json`. A wallet client built through the Loom
SDK uses Kohaku as its privacy and account-security tooling stack. Loom should
not vendor Kohaku or fork its interfaces unless upstream becomes unavailable
or an audited compatibility shim is required.

## Goals

- Keep the Loom account usable without any privacy provider while making
  Kohaku the required privacy runtime for SDK-built clients.
- Let wallet clients add private receiving, private transfers, shielded DeFi,
  and private state reading through Kohaku packages.
- Treat provider choice as a privacy primitive: user RPC, local node,
  Helios-backed verified RPC, Colibri-compatible providers, and custom
  transports must have explicit metadata budgets.
- Make per-dapp account creation and private top-up flows ordinary SDK
  concepts, not advanced user workflows.
- Preserve local-first scanning: only the user's wallet should need the full
  graph of identities, app accounts, notes, viewing keys, and recovery state.
- Keep privacy execution replaceable at the provider/protocol level. A
  Railgun, Aztec, stealth-address, or privacy-pool failure must not block
  ordinary account control or exit.
- Give SDK users a stable shape for integrating privacy protocols without
  granting those protocols account-wide authority.
- Track Kohaku account-security tooling as a migration and compatibility
  target without silently replacing LoomAccount.

## Non-goals

- No mandatory Railgun, Aztec, relayer, prover, scanner, indexer, or viewing
  service in Loom core. The SDK may require Kohaku without making any one
  privacy service account-authoritative.
- No public global registry linking a user's public accounts, private notes,
  guardians, app identities, and cross-chain roots.
- No claim that a privacy adapter is safe until its protocol assumptions,
  metadata flows, dependency graph, and client implementation have been
  independently reviewed.
- No smart-account upgrade path, arbitrary delegatecall, or privileged privacy
  module.
- No import of Kohaku account verifier contracts into Loom core until there is
  an explicit audit plan, gas review, delayed migration path, and guardian
  cancellation story.

## Adapter classes

| Adapter | Responsibility | Must not do |
|---|---|---|
| `KohakuHost` | Provide the host services expected by Kohaku plugins | Leak keys, storage, or network access without a metadata budget |
| `PrivateScanner` | Discover notes, stealth payments, commitments, nullifiers, balances, and recovery alerts with local secrets | Upload the user's full account graph to one service |
| `PrivateExecutionAdapter` | Wrap Kohaku plugin operations or protocol-specific private transactions | Become the only way to spend or exit |
| `ShieldedPoolAdapter` | Use Kohaku-compatible shield, unshield, transfer, and pool-state flows | Hide token, fee, relayer, or proof assumptions |
| `KohakuProviderProfile` | Describe user RPC, Helios, Colibri, local-node, or custom transport mode | Use a hardcoded default RPC before the user chooses |
| `StealthReceiveAdapter` | Derive and scan per-contact or per-application receive addresses | Reuse one global public identity by default |
| `MetadataBudget` | Estimate disclosure for RPC, indexer, relayer, prover, and timing choices | Treat zero-knowledge proofs as full privacy by default |
| `ViewingKeyStore` | Hold scoped local viewing and scanning secrets | Put secrets in URLs, logs, telemetry, or public account state |

## Target protocol profiles

### Railgun profile

Railgun is an EVM-side private balance and transfer system. Loom should use
`@kohaku-eth/railgun` as the default EVM shielded-pool backend in the SDK.

Required adapter behavior:

- Model the Railgun lifecycle as account creation, indexer creation,
  incremental sync, shielded address discovery, balance reads, shielding,
  private transfer, and unshielding.
- Build shield, unshield, private transfer, and private DeFi calls through the
  Kohaku Railgun package without granting Railgun any Loom account admin
  authority.
- Keep Railgun viewing keys local and scoped per user profile or application
  context.
- Bind any relayer, fee token, recipient, amount, expiry, and chain selection
  to explicit user intent.
- Persist indexer progress locally when the user allows it. Re-indexing from
  the beginning on every wallet launch creates bad UX and unnecessary metadata
  exposure.
- Route large unshield operations through Loom vault delays when the asset is
  marked as long-term storage.
- Label degraded modes when scanning depends on a third-party indexer or
  remote full-wallet scan.

Rejected design: installing a mandatory Railgun module in every Loom account.
That would make a privacy provider part of account liveness and would create
unnecessary public coupling for users who do not use that system.

### Tornado compatibility profile

The current Kohaku docs refer to `@kohaku-eth/tornado`, while the upstream
repository and npm registry expose `@kohaku-eth/tornado-cash`. Loom tracks the
published package name and treats it as a compatibility surface, not as a
default user flow.

Required adapter behavior:

- Keep note material local and scoped.
- Never auto-route user funds through this adapter.
- Require explicit protocol, dependency, jurisdictional, relayer, and
  withdrawal-safety review before production UX exposure.
- Preserve Loom native exit, recovery, and migration paths independently of
  this adapter.

### Aztec profile

Aztec is a privacy-first L2 with private state and a non-EVM execution model.
Kohaku does not currently provide the Aztec adapter in the package list Loom is
binding to, so Aztec should be wrapped as a separate `PrivateExecutionAdapter`
that follows the same host, metadata-budget, storage, and walkaway rules.

Required adapter behavior:

- Keep Aztec account, note, and viewing data separate from Loom public account
  state unless the user chooses a binding.
- Represent L1/L2 messages, bridge exits, and finality assumptions as
  verifiable state, not as trusted wallet text.
- Avoid assuming EVM module compatibility. Aztec integration belongs in the
  SDK/client adapter layer until a reviewed on-chain bridge or verifier path
  exists.
- Let users keep separate Aztec identities for privacy-sensitive contexts.
- Support walkaway operation through user-controlled keys, open tooling, and
  documented bridge exit paths.

Rejected design: making one public Loom L1 root automatically identify all
Aztec usage. Cross-context identity linking is opt-in and should be rare.

### Kohaku account-security profile

Kohaku includes `packages/pq-account`, an ERC-4337 account research package
that verifies two signatures and publishes verifier contracts for several
schemes. Loom should include this in the SDK stack as a source-level capability
and future migration target.

Loom adopts the same security direction for future account compatibility:
enable an ERC-4337 account to verify two signatures rather than only one. The
goal is hybrid authorization: keep the current ECDSA path for ecosystem
compatibility while adding a second post-quantum signature requirement when a
user chooses that account profile. This is a migration and compatibility
strategy, not a reason to weaken today's passkey, guardian, vault, recovery,
or delayed-migration guarantees.

Required behavior:

- Do not replace LoomAccount with this account package in core.
- Expose it through SDK metadata as a compatibility or migration target.
- Require delayed migration, destination codehash binding, guardian
  cancellation, and native exit fallback before any live movement of funds.
- Require independent audit, gas review, deployment verification, and
  dependency review before production support.
- Keep users able to choose the normal Loom account path when they do not want
  this account profile.
- Preserve hybrid verification semantics: the account profile must verify both
  the existing ECDSA-style signature path and the additional post-quantum
  signature path for protected operations, rather than treating the new path as
  a drop-in replacement.

## Data-flow model

```text
User device
    |
    |-- local credential store
    |-- local viewing/scanning keys
    |-- local account graph
    |
    |-- verified public state client
    |       `-- untrusted RPC/light-client transport
    |
    `-- Kohaku-compatible privacy layer
            |-- @kohaku-eth/plugins host
            |-- @kohaku-eth/provider transport
            |-- @kohaku-eth/railgun adapter
            |-- @kohaku-eth/privacy-pools adapter
            |-- @kohaku-eth/tornado-cash adapter
            |-- Aztec private-execution adapter
            `-- stealth receive adapter
```

The adapter may query remote services, but every query must have an explicit
metadata budget. A wallet should be able to say: "this request reveals one
chain and one token", "this request reveals a full address set", or "this
request reveals a timing link between public and private activity".

## Contract surface for adapters

Adapters use existing Loom surfaces instead of new core privileges:

- `GranularSessionValidator` for bounded protocol calls, relayers, fee tokens,
  selectors, expiry, and use limits.
- `VaultHook` for delayed movement of long-term assets before shield/unshield
  flows.
- `scheduleMigration` and direct execution for provider-independent exit.
- `configHash`, `configVersion`, and future L1 keystore proofs for portable
  authority updates.
- ERC-1271 and explicit validators for user-approved protocol signatures.

If an adapter needs more power than those surfaces provide, it requires a new
decision record, threat-model update, tests, and an audit plan.

## Acceptance gates

A privacy adapter is not production-ready until it has:

- A documented protocol profile and threat model.
- Local-first scanning with no mandatory Loom server.
- A walkaway path using open tools and user-selected endpoints.
- Explicit relayer, prover, indexer, bridge, and finality assumptions.
- Explicit provider mode: user RPC, local node, Helios-verified RPC,
  Colibri-compatible provider, or custom transport.
- Tests for permission binding, expiry, cancellation, fee limits, and vault
  interaction.
- Metadata-leakage review for RPC queries, indexer requests, relayer
  submission, timing, browser storage, telemetry, and backup.
- Degraded-mode UX rules for unavailable scanners, unverified state, stale
  proofs, and unsupported networks.
- Jurisdictional, dependency, relayer, withdrawal, and abuse-resistance review
  for any adapter that touches legally sensitive privacy infrastructure.
- Clean dependency audit or documented safe override for every Kohaku package
  before production SDK release.

## First implementation step

The first SDK package exposes Loom wrappers and metadata-budget types around
Kohaku's plugin boundary and depends on Kohaku directly. Railgun should be the
first concrete implementation because Kohaku already publishes a Railgun
package. Aztec comes later as a separate adapter because it is not part of the
current Kohaku package set Loom is binding to.
