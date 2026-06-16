# Product Principles

Loom is a tool for users, not an empire around users. Security, privacy, and
convenience features must increase user agency without making Loom or another
single actor necessary.

## The walkaway test

Every release must answer yes to this question:

> If Loom's developers, hosted frontend, bundler, paymaster, RPC, indexer,
> notification service, and recovery coordinator disappear forever, can a
> user still discover the account state, verify it, recover access, and
> publish an authorized operation using independent software?

A feature that fails this test is not part of the sovereign path. It may exist
only as an optional convenience layer with a documented provider-independent
fallback.

## Non-negotiable properties

- **Permissionless operation:** no allowlist, API key, account, subscription,
  or provider approval is required to use the account.
- **No permanent veto:** no developer, guardian, bundler, paymaster, RPC,
  indexer, module registry, or frontend can permanently prevent legitimate
  account use.
- **User-chosen safety delays:** freezes and timelocks may temporarily delay
  actions only according to immutable, visible rules selected by the user.
  They must have provider-independent completion or cancellation paths.
- **Credible neutrality:** the core does not classify users, applications, or
  destinations as deserving or undeserving of access.
- **Walkaway recovery:** recovery is executable from public chain data and
  guardian-held authority without a Loom-operated coordinator.
- **Exit over loyalty:** users can use another client, bundler, RPC, paymaster,
  validator implementation, or future account version without permission.
- **Privacy by default:** clients minimize address correlation, identity
  disclosure, metadata leakage, and centralized query logs. The contracts do
  not require identity-bearing services.
- **Truthful UX:** convenience automation must show the resulting calls,
  authority, fees, routes, delays, and trust assumptions before consent.
- **Open verification:** source, bytecode, deployment inputs, interfaces, and
  security assumptions are independently reproducible and auditable.
- **Narrow authority:** convenience modules receive the minimum explicit,
  bounded, queryable, and revocable authority needed for their task.
- **Rooted portability:** long-term cross-chain authority should anchor in
  Ethereum L1 or another explicitly verified root, never in a Loom-operated
  signer, sequencer promise, or opaque bridge.

## Security and unstoppable operation

Unstoppable does not mean every requested action executes immediately.
Immediate arbitrary execution after one compromised key is not sovereignty.

Loom separates:

- low-risk actions, which may use a primary credential or bounded session;
- high-risk actions, which use a visible user-chosen delay;
- recovery, which uses guardian threshold approval, delay, cancellation, and
  expiry;
- emergency freeze, which temporarily blocks ordinary execution but leaves
  exact recovery and cancellation paths available.
- vault-like storage, which should use stricter withdrawal policies than daily
  spending accounts once vault modules are introduced.

These restrictions are acceptable only because no external operator controls
them and every path is defined by immutable on-chain rules.

## High-UX without capture

The wallet client should hide complexity during normal use while always
preserving a portable expert path.

- Cross-chain sends may automatically choose routes, but the user sees what
  is paid, received, bridged, swapped, and trusted.
- Token-fee payment may be one tap, but native gas and another paymaster remain
  available.
- Default RPC and bundler selection may be automatic, but custom endpoints and
  direct infrastructure paths remain first-class.
- Guardian setup may be guided, but no Loom guardian is mandatory or silently
  privileged.
- Security warnings and simulations protect users, but the client does not
  impose a centralized censorship policy.
- Account and application activity should use separated identities where
  practical; only the user's local wallet should hold the global view.
- L1/L2 routing may be abstracted in the normal user experience, but the
  account authority root, proof assumptions, fees, and escape paths must remain
  inspectable.

## Contract review questions

Every contract change must answer:

1. Can this create a permanent veto over the account?
2. Can it silently expand any actor's authority?
3. Does it require an off-chain service for safety or liveness?
4. Is the authority explicit, bounded, queryable, and revocable?
5. Can an independent client reproduce and submit the operation?
6. Does it increase public correlation or identity leakage?
7. Does the UI convenience path preserve a provider-independent fallback?
8. Are all delays, fees, and trust assumptions visible before consent?

Any uncertain answer blocks audit-candidate status.
