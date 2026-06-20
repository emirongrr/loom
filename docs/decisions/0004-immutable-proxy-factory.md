# Decision 0004: Immutable Proxy Factory

## Status

Accepted.

## Context

Loom originally deployed full account bytecode per account. That model is
simple and strong for auditability, but it repeats the same runtime bytecode
for every user and raises account creation cost.

Current smart-wallet ecosystems commonly separate account deployment from a
shared implementation. WalletBeat beta tracks contract wallets such as Ambire,
Coinbase Smart Wallet, Kernel 7702, MetaMask 7702 delegation, and Rainbow
Calibur primarily around open source code, `validateUserOp`, ERC-1271, and
delegation capabilities. Those examples make shared implementation and proxy
deployment a normal pattern, but Loom's architecture cannot accept admin
upgrade keys, global registries, or provider-controlled account authority.

## Decision

Loom uses an immutable shared implementation proxy for factory-deployed
accounts.

- The proxy stores the implementation as an immutable code value.
- The proxy has no admin, beacon, registry authority, mutable implementation
  slot, or upgrade selector.
- The factory stores the account implementation as an immutable constructor
  value.
- New account versions require a new implementation, new factory, and explicit
  user migration.
- The account implementation keeps a one-time initializer for proxy storage.
- The previous constructor path remains available as a reference profile and
  for EIP-7702 runtime-code preparation.
- Each app factory deploys its own `AppAccountRegistry`; there is no global
  Loom registry.
- Registry membership supports app-local analytics only and grants no account
  authority.

## Consequences

Positive:

- Account deployment cost can be reduced without adding upgrade authority.
- Integrators can deploy their own factory and registry while using the same
  audited account implementation.
- Factory events and per-app registries support public account-count and TVL
  analytics without requiring users to register with Loom.

Risks:

- The shared implementation becomes a code-availability and codehash
  verification dependency for all accounts using that factory.
- Delegatecall dispatch makes storage layout and initializer safety audit
  critical.
- A flawed implementation cannot be patched in place; users must migrate.
- App registries can correlate accounts created by one factory and must not be
  treated as privacy-preserving identity systems.

Required controls:

- Reproducible deployment manifests must publish implementation, proxy,
  factory, registry, and EntryPoint code hashes.
- Tests must prove one-time initialization, no reachable implementation
  mutation, no upgrade/admin selectors, proxy storage separation, registry
  factory-only registration, and duplicate-count protection.
- Wallets must display proxy profile and migration path honestly.
- Future implementation changes must use migration documentation and fresh
  audit evidence, not an upgrade transaction.

## Rejected Alternatives

- Upgradeable proxy: rejected because it creates a permanent control point and
  weakens account unruggability.
- Global registry: rejected because it creates a public account-correlation
  layer and a social control point.
- Factory owner/deployer mutation: rejected because it lets an operator change
  future account semantics without users selecting a new factory.
- Full bytecode deployment only: retained as a reference profile, but no longer
  the default because deployment cost matters for broad adoption.
