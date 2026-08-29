# Decision 0009: App Account Registry

## Status

Accepted.

## Context

An architecture review flagged `src/AppAccountRegistry.sol` as a
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

Keep `AppAccountRegistry` as the per-factory, factory-only, append-only
membership set. New-generation factories also bind one random RP-scoped
`accountHandle` to each account and expose both lookup directions. This is discovery
metadata and grants no account authority; the account's live validators remain
authoritative. There is no membership-only registration path: every registered
account carries exactly one non-zero `accountHandle` from the atomic factory call.

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

- The registry must remain per-factory. A wallet identity is random and binds
  exactly one account; it must not become an owner-to-accounts index or a global
  registry connecting a user's accounts.
- Membership must remain factory-only and append-only, with duplicate-count
  protection, and must never gate account control. A registered account must
  never exist with a zero or missing wallet identity.
- Reproducible deployment manifests must publish the registry codehash
  (decision 0004).

## Privacy Analysis

The registry reveals that a given address is an account created by a specific
factory and that a random RP wallet identity resolves to it. The deployment and
address are already public; the additional identifier creates a durable
credential-to-account correlation for whoever can observe the authenticator
metadata. It contains no owner, label, guardian, or personal data.

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
