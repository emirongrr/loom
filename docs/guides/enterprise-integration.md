# Enterprise Integration Guide

This guide is for a company — a bank, fintech, payment app, brokerage, or super
app — that wants to give its users a self-custody wallet inside its own product.
The company owns the user experience; Loom is the wallet engine underneath. The
user keeps custody the entire time.

The flow described here is implemented end to end, and verified on every run, in
[`examples/enterprise-onboarding.mjs`](../../examples/enterprise-onboarding.mjs).
Run it with `node examples/enterprise-onboarding.mjs`.

## The division of responsibility

```
  Institution (owns the product)         Loom (owns the wallet engine)
  ------------------------------         -----------------------------
  onboarding / KYC                       immutable account core
  fiat rails (fiat -> stablecoin)        validators, hooks, recovery
  RPC + bundler infrastructure           counterfactual deployment
  its own frontend and UX                guardian-based recovery
  its own factory + AppAccountRegistry   session keys, spend policies

                    User (owns authority)
                    ---------------------
                    passkey / key material
                    guardians of their choosing
                    the account and its funds
```

The institution does **not** fork Loom. It builds its frontend on the Loom SDK
and supplies its own infrastructure adapters. The Loom core is never modified,
and no Loom-operated service sits in the path.

## What the institution supplies, and what it must not

The SDK deliberately ships no default RPC, bundler, paymaster, signer, or
recovery coordinator. The institution supplies these as adapters:

- an **RPC endpoint** (its own or its user's), passed as the provider profile;
- a **bundler transport** for broadcasting user operations;
- optionally a **paymaster** to sponsor gas for its users.

The one thing the institution must **not** supply is the user's key material.
Authority comes from the user's passkey (or other user-held signer). The
institution's bundler only broadcasts operations the user's key has already
signed; it can neither sign nor alter them. This asymmetry — infrastructure from
the institution, authority from the user — is what keeps the account
self-custody.

## The onboarding flow

1. **KYC and onboarding happen in the institution's system.** From Loom's
   perspective this is opaque and off-chain: no identity data, no institution
   key, and no institution address is written into the account.

2. **The user registers a passkey** through the institution's UI
   (`createPasskeySigner`). In a browser this is the WebAuthn API; the private
   key never leaves the user's device.

3. **The institution derives the counterfactual account** with its own factory
   (`prepareDeployAccount`). The address is deterministic, so it can receive the
   user's first deposit before any on-chain deployment.

4. **The institution converts fiat to stablecoin** on its own rails and sends it
   to the counterfactual address — an ordinary inbound transfer, no special
   integration.

5. **The user's first operation is signed by the passkey and broadcast by the
   institution's bundler.** The broadcast operation carries the user's signature
   and the user's account as sender: proof that authority came from the user.

6. **The account starts guardian-protected.** The institution is not a guardian;
   guardians are the user's own keys or devices. Recovery rotates authority
   after a threshold of guardian approvals plus an on-chain delay, and never
   grants guardians spending power.

## Why the user stays self-sovereign

The binding guarantee is the "walkaway" property: the account keeps working with
only the adapters the user supplies, so the user does not depend on the
institution surviving.

- Account control (operate, grant sessions, propose recovery) is prepared
  offline and can be broadcast through any transport, not just the institution's.
- If the institution shut down tomorrow, the user could point the SDK at any RPC
  and bundler and continue — including recovering the account through their
  guardians.
- The core enforces this by construction: no admin, no upgrade proxy, no
  mandatory Loom or institution service, and at least one independently
  executable control path (see [`ARCHITECTURE.md`](../../ARCHITECTURE.md)).

The example script proves this concretely: it runs the whole flow with a
global-`fetch` trap installed, so any hidden default-provider call would fail the
run.

## Metrics without breaking privacy

Institutions need product metrics: how many wallets they onboarded, which
wallets to include in a TVL figure, and how many distinct institutions use Loom.
The core supports this without a global registry.

Each institution deploys its own `AppAccountRegistry` alongside its factory
(see [`docs/decisions/0004-immutable-proxy-factory.md`](../decisions/0004-immutable-proxy-factory.md)
and [`docs/decisions/0009-app-account-registry.md`](../decisions/0009-app-account-registry.md)).
The registry offers a cheap wallet count (`accountCount`) and an O(1) membership
check (`isAccount`) scoped to that institution's cohort. It is deliberately:

- **per-institution**, not a global Loom registry — so no cross-institution
  correlation layer exists;
- **non-linking** — it records each account once and never maps a user's several
  accounts together, nor touches guardian data;
- **authority-free** — membership grants no control over any account.

Everything it exposes is already public from the factory's deploy events and the
deterministic CREATE2 address, so it reveals nothing new while saving an indexer
for the common count and membership queries. TVL itself is computed off-chain by
iterating the cohort; the registry supplies the set, not the balances.

## Related material

- [`examples/enterprise-onboarding.mjs`](../../examples/enterprise-onboarding.mjs) —
  the runnable flow.
- [`examples/individual-passkey-wallet.mjs`](../../examples/individual-passkey-wallet.mjs) —
  the same core serving a solo user with guardian recovery.
- [`docs/design/permissions.md`](../design/permissions.md) — session-key and
  spend-policy models an institution can layer on top.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the invariants this integration
  relies on.
