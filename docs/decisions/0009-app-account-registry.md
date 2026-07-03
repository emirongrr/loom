# Decision 0009: App Account Registry

## Status

Accepted.

## Context

An architecture review flagged `src/factory/AppAccountRegistry.sol` as a
candidate for deletion, on the grounds that everything it records is already
derivable from the account codehash or the factory's `LoomAccountCreated`
event, while it costs gas on every deployment and adds a contract to the audit
surface.

That view is correct for the individual-wallet profile but misses the
enterprise-platform profile, which is a first-class Loom goal. Loom is designed
to run as the wallet engine behind an institution's own client: the institution
onboards its users, issues self-sovereign passkey accounts, and presents a clean
UX while Loom operates underneath. Each institution deploys its own factory (and,
per decision 0004, its own registry) rather than forking the audited account
implementation. Those institutions need account-level operational metrics:

- how many accounts their factory has created (`accountCount`);
- which accounts belong to their deployment, for TVL aggregation and
  institution-scoped tooling (`isAccount` plus `AccountRegistered` events);
- an on-chain membership predicate other institution-scoped contracts can gate
  on (for example, a paymaster that sponsors gas only for accounts the
  institution created).

Decision 0004 already committed to a per-app registry supporting "app-local
analytics only" that "grants no account authority". This record makes that
rationale explicit, evaluates it against the deletion proposal and Loom's
privacy invariants, and settles the question rather than leaving it implicit.

## Decision

Keep `AppAccountRegistry` as-is. It is a per-factory, factory-only,
append-only membership set with a running count and an `AccountRegistered`
event, and it grants no account authority.

The registry is deliberately **not** enumerable on-chain: it exposes a count
and an O(1) membership predicate, but the list of accounts is obtained from
`AccountRegistered` events, not an on-chain array. Backends compute TVL and
build account lists by indexing those events. This keeps per-deployment gas
minimal and avoids materializing a stronger on-chain correlation surface than
already exists.

Institution-level meta-metrics (how many distinct institutions use Loom, across
factories) remain off-chain: they are derived by counting factory deployments,
never by a global on-chain registry, which decision 0004 already rejected.

## Consequences

Positive:

- Institutions read their live account count with a single storage load rather
  than replaying event history.
- Institution-scoped contracts (paymasters, policy or TVL aggregators) can gate
  on `isAccount` without trusting an off-chain index.
- Event-based enumeration supports account lists and TVL without adding
  per-deployment array-append gas or an on-chain account list.

Risks:

- The registry can correlate accounts created by one factory and must not be
  presented as a privacy-preserving identity system. This is the same residual
  property recorded in decision 0004.

Required controls:

- The registry must remain per-factory. No global registry, and no mapping from
  a user or owner to their set of accounts, may be added: the architecture
  invariant forbids a global registry connecting a user's accounts, and this
  registry stays compliant only because it records single-account membership
  with no cross-account linkage.
- Membership must remain factory-only and append-only, with duplicate-count
  protection, and must never gate account control.
- Reproducible deployment manifests must publish the registry codehash
  (decision 0004).

## Privacy Analysis

The registry reveals only that a given address is an account created by a
specific institution's factory. That fact is already public: the account
address is deterministically derivable via CREATE2 from public factory inputs,
and its deployment is already an on-chain transaction that emits
`LoomAccountCreated`. The registry therefore discloses nothing beyond existing
on-chain data.

Critically, it does not link a user's multiple accounts to each other, does not
reference guardians or the guardian root, and does not touch validator or
recovery configuration. The architecture invariant — "the core must not create
a global registry connecting a user's accounts" — is not engaged, because the
registry is per-factory and stores single-account membership with no
owner-to-accounts relation.

## Rejected Alternatives

- Delete the registry: rejected. It loses the single-slot account count and the
  on-chain membership predicate that institution-scoped contracts depend on.
  Reconstructing the count from events requires an indexer, and an on-chain
  membership gate cannot be replaced by off-chain event data at all.
- On-chain enumeration (store an account array): rejected. Events already
  provide the list off-chain; an array adds per-deployment gas and materializes
  a stronger, permanent on-chain correlation surface for no capability the
  metrics use case needs.
- Global (cross-factory) registry: rejected, consistent with decision 0004,
  because it creates a public account-correlation layer and a social control
  point, and would violate the no-global-registry invariant.
- Owner-to-accounts index: rejected because linking a user's accounts is
  exactly the correlation the privacy invariant forbids; institutions that need
  to associate accounts with their own users do so in their own backend, off
  Loom's public state.
