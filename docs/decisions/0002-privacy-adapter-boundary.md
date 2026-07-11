# Kohaku privacy adapter boundary

Status: accepted
Date: 2026-06-16

Note: the boundary below still holds, but the packaging step has changed. Privacy
is a separate, optional install and is never an `@loom/sdk` dependency; it is
reached only through a structural adapter. See the "SDK and tooling" section of
`docs/design/architecture.md`.

## Problem

Loom needs to use Kohaku directly for private receiving, private transfers,
shielded pools, provider abstraction, and future private execution while
preserving walkaway operation. Embedding Kohaku or one privacy protocol into
the immutable account core would make that package or protocol a liveness and
trust dependency for every user.

## Evidence

The architecture constitution already forbids mandatory relayers, indexers,
module registries, or privacy providers. Kohaku publishes packages for
plugins, provider abstraction, Railgun, privacy pools, Tornado compatibility,
and account-security research. The current Loom account exposes bounded
session permissions, vault delays, direct execution, migration, ERC-1271, and
cross-chain root surfaces that Kohaku-compatible adapters can use without
receiving admin authority.

Railgun and Aztec also have different execution models. Railgun fits an EVM
shielded-pool profile; Aztec is a privacy-first L2 with separate private state
and bridge assumptions. A single mandatory contract integration would be too
broad and would leak unnecessary coupling.

## Options

- Embed a default privacy module in every Loom account. Rejected because it
  creates a mandatory provider/protocol dependency and unnecessary public
  correlation.
- Add protocol-specific hooks to core. Rejected until concrete audited
  adapters prove that existing session, vault, migration, and verification
  surfaces are insufficient.
- Define a Kohaku-compatible adapter boundary in the SDK/client layer. Accepted
  because it lets Loom use upstream Kohaku directly while preserving
  replaceability and keeping account authority narrow.

## Decision

Kohaku remains a client/SDK integration, not an account-core dependency. The
first implementation step is a privacy package seed that declares Kohaku as
direct SDK dependencies and defines local-first scanning, private execution,
shielded-pool, stealth receive, metadata-budget, and viewing-key
responsibilities.

Concrete Railgun and Aztec adapters must be separate reviewed integrations.
They may use Loom sessions, vaults, migration, and verified-state APIs, but
they must not receive account admin authority or become required for account
operation.

## Residual risks

- The adapter interfaces are not yet executable code.
- Railgun and Aztec dependencies, licenses, protocol assumptions, and live
  network behavior still require separate review.
- Privacy depends heavily on client behavior, local storage, query batching,
  relayer selection, timing, and user education.
- A future adapter may still leak correlation if its metadata budget is wrong
  or ignored by the wallet UI.
