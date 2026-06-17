# Loom Privacy Package

This package is the seed for Loom's Kohaku-backed privacy SDK runtime. Loom
SDK clients should use upstream Kohaku packages directly instead of
re-implementing their plugin and provider model.

The package depends on:

- `@kohaku-eth/plugins`
- `@kohaku-eth/provider`
- `@kohaku-eth/railgun`
- `@kohaku-eth/privacy-pools`
- `@kohaku-eth/tornado-cash`

It also tracks Kohaku `packages/pq-account` as a required source-level stack
capability in `kohaku-stack.json`. Kohaku does not currently expose that
subtree as an npm package, so Loom records it as an upstream source dependency
rather than pretending it can be installed from npm.

These are package dependencies, not optional peer suggestions. A third-party
wallet client built through the Loom SDK receives the Kohaku runtime boundary
as part of the SDK.

This package does not yet ship a production Aztec, stealth-address, or
privacy-pool release profile. It includes the Kohaku host runtime boundary, an
executable Kohaku-style shielded-pool adapter wrapper, a Railgun adapter
profile, and scoped local scan-state storage that wallet clients and
third-party builders can use without changing Loom core contracts.

## Design rules

- Kohaku is the required privacy runtime for Loom SDK clients.
- Kohaku account-security tooling is part of the SDK stack, but it is not
  imported into Loom core contracts until its verifier contracts, gas profile,
  deployment assumptions, and migration path are reviewed.
- Loom core remains usable without this package.
- Privacy actions remain user-initiated; bundling Kohaku in the SDK must not
  create a mandatory relayer, indexer, prover, scanner, or account authority.
- Viewing keys, scanning keys, note data, and account graphs stay local unless
  the user explicitly exports or shares them.
- Kohaku hosts and adapters must expose metadata costs before performing
  remote queries.
- Every adapter must preserve native Loom account exit, recovery, migration,
  and direct execution paths.

## Current surface

- `KohakuHost`: Loom's host boundary for Kohaku plugin storage, network,
  keystore, and provider access.
- `createKohakuShieldedPoolAdapter`: executable wrapper for Kohaku-style
  shield, unshield, private transfer, account creation, and private broadcast
  plugin methods.
- `createRailgunAdapterProfile`: Railgun profile that initializes a
  Kohaku-compatible Railgun plugin, exposes balance/sync/private-operation
  methods, and persists local scan checkpoints after metadata-budget approval.
- `createPrivateScanStateStore`: local scan checkpoint storage scoped by
  protocol, chain, account, application, and scan scope.
- `PrivateScanner`: local-first discovery of private notes, stealth payments,
  commitments, nullifiers, and recovery alerts.
- `PrivateExecutionAdapter`: construction of protocol-specific private
  operations, bridge messages, and exit transactions.
- `ShieldedPoolAdapter`: Railgun-like shield, unshield, private transfer, and
  private DeFi flows.
- `StealthReceiveAdapter`: per-application and per-contact receiving flows.
- `MetadataBudget`: typed disclosure accounting for RPC, indexer, relayer,
  prover, bridge, and timing metadata.
- `ViewingKeyStore`: scoped local secret storage and export warnings.
- `KohakuAccountSecurityProfile`: source-level tracking for Kohaku account
  security tooling that may become a migration or compatibility target after
  audit.

The first runtime artifact is `src/index.js`, with TypeScript declarations in
`src/index.d.ts`. The runtime enforces explicit provider consent and metadata
budget checks before any network call reaches a Kohaku adapter and before any
privacy plugin operation executes. Concrete implementation packages should
import Kohaku directly.

## Protocol profiles

Railgun is integrated through `@kohaku-eth/railgun` as the default EVM
shielded-pool profile boundary. Production release still requires live
network rehearsal, dependency audit remediation, relayer/indexer/prover
failure evidence, and protocol-specific review. Privacy pools should use
`@kohaku-eth/privacy-pools`. The Kohaku docs currently refer to
`@kohaku-eth/tornado`, but the repository and npm registry expose
`@kohaku-eth/tornado-cash`; Loom tracks the published package name. That
package is part of the SDK-accessible stack because it exists upstream, but it
must remain behind explicit protocol, dependency, jurisdictional, relayer, and
withdrawal-safety review before any production UX exposes it. Aztec should be
integrated as an optional private-execution environment with its own state,
finality, and bridge assumptions because it is not part of the current Kohaku
package set Loom binds to. No protocol becomes mandatory Loom account
infrastructure.

Kohaku `packages/pq-account` should be treated as an account compatibility and
migration research target, not as a silent replacement for LoomAccount. Any
use in production must preserve delayed migration, guardian cancellation,
native account exit, and no developer upgrade authority.

The account-security philosophy is hybrid verification. A future ERC-4337
account profile should be able to verify two signatures: the existing
ECDSA-compatible path and an additional post-quantum signature path. That lets
Loom keep today's interoperability while giving users a migration route toward
stronger long-term signature assumptions.

## Kohaku learnings to carry into Loom SDK

- Railgun integration is account plus indexer plus provider. Loom SDK needs a
  first-class private account lifecycle, not only a transaction builder.
- The indexer must support incremental sync and local receipt persistence.
  Re-indexing from genesis on every app launch is not acceptable UX or privacy.
- Provider selection is part of privacy. User-defined RPC, Helios-backed
  verified RPC, and Colibri-compatible provider modes should be represented as
  explicit provider profiles.
- Shielding, transfer, and unshielding produce normal transactions. Loom must
  route those through granular permissions, vault delays, and metadata budgets.
- Relayer use can improve UX but changes metadata and fee assumptions. It must
  be explicit, bounded, and never mandatory.
- A wallet should make many accounts easy: per-dapp identities, private
  top-up paths, and separate scan scopes should be normal SDK concepts.
- Current Kohaku dependency resolution has unresolved npm audit findings in
  transitive packages. This package is an integration seed, not a production
  SDK release, until those findings are fixed upstream, safely overridden, or
  isolated with evidence.

See `docs/design/privacy-adapters.md` for the binding architecture.
