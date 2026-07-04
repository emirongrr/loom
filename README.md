# Loom

**Self-sovereign wallet infrastructure for Ethereum**

Loom is a contracts-first wallet infrastructure project for users and teams
that should not have to choose between mainstream usability and self-custody.

The goal is not to build another closed wallet application. The goal is to
build an open, modular account stack that remains usable, recoverable, and
verifiable even if the original Loom team, frontend, bundler, paymaster, RPC,
or recovery coordinator disappears.

Loom starts with immutable smart accounts and grows outward through narrowly
scoped validators, policies, recovery modules, client software, SDKs, and
eventually privacy and cross-chain verification layers. The core rule is
simple: convenience may improve, but user sovereignty must not weaken.

## What Loom Is

Loom is an Ethereum account layer designed around:

- passkeys instead of seed phrases for everyday access;
- social recovery without custodians;
- visible delays for high-risk actions;
- bounded session permissions for apps and agents;
- policy-controlled spending and paymaster use;
- provider-independent account operation;
- open standards where they preserve user exit;
- privacy as a security property, not a cosmetic feature.

This repository contains the on-chain account and authorization layer plus
early local SDK packages for wallet builders. It does not contain the future
mobile wallet, fintech-style user experience, production private transfer
system, light client, cross-chain router, or hosted infrastructure.

## Why It Exists

Most users cannot safely manage seed phrases, but replacing seed phrases with
a company account, hosted recovery, or invisible infrastructure dependency is
not self-custody. Loom is built for a different path:

- users create and use accounts with hardware-backed passkeys;
- recovery is distributed across independently chosen guardians;
- high-risk changes are delayed and cancelable;
- permissions are explicit, bounded, queryable, and revocable;
- no developer key, factory key, module registry, paymaster, RPC, frontend, or
  recovery service can permanently control funds;
- independent clients can read state and publish authorized operations.

The product should feel simple, but the escape hatch must stay real.

## Privacy Direction

Financial privacy is part of account security. A wallet that reveals every
application relationship, balance query, recovery contact, and payment graph
does not give users meaningful autonomy.

Loom's contract core therefore avoids mandatory global registries, mandatory
identity providers, public account-linking mechanisms, and provider-controlled
recovery paths. Privacy protocols, viewing systems, private state reads, and
cross-chain proof systems belong behind optional, audited interfaces rather
than inside the immutable core before their assumptions are understood.

The long-term wallet stack should support:

- separate application identities;
- metadata-minimizing account discovery;
- private or privacy-preserving transfers where available;
- user-held viewing capability rather than provider-held surveillance;
- local or verified state reads instead of trusting hosted RPC responses;
- no unnecessary public linkage between L1 roots and L2 activity.

Privacy features must be explicit about what they hide, what they reveal, who
can block them, and which assumptions remain.

## L1 Root, L2 UX

Loom is designed around Ethereum L1 as the long-term trust root for account
authority, while users should eventually interact across L2s without feeling
the fragmentation.

The intended architecture is:

- L1 remains the root for durable account and recovery authority.
- L2 accounts remain usable directly and locally.
- Cross-chain configuration sync is added only through trustless proofs with
  documented finality, latency, and privacy assumptions.
- Bridges, sequencer promises, multisigs, or Loom-operated signers must not
  become account-authority roots.
- The user experience can abstract chains, gas, routes, and settlement, but it
  must still expose the trust assumptions when they matter.

Until that proof layer is specified and audited, Loom keeps configuration
local per chain. That is less magical, but safer.

## Modularity Without Capture

Loom should be extensible without turning extensibility into a hidden upgrade
system.

The account core is immutable and intentionally narrow. New capabilities should
arrive as:

- validators with explicit authentication profiles;
- hooks that enforce bounded execution policy;
- recovery modules with narrow authority;
- adapters for standards compatibility where they do not widen authority;
- client and SDK layers that improve UX without becoming mandatory.

Unsupported execution modes fail closed. There is no arbitrary delegatecall
execution, no proxy upgrade key, no mutable implementation slot, no privileged
factory path, and no permanent Loom administrator.

## Vault Direction

Not all assets should have the same security model. Loom is moving toward a
vault-oriented account architecture where daily spending, app sessions, and
long-term storage can have different policies.

The intended direction is:

- daily accounts use passkeys, spending policies, and session permissions;
- vaults use stronger delays, guardian visibility, and stricter withdrawal
  paths;
- large balance movement is delayed, cancelable, and observable;
- migration remains possible without asking Loom for permission;
- asset movement should be atomic where the underlying assets allow it.

The current contracts provide the account, permission, recovery, policy,
delayed migration, and optional vault hook foundations. Vault behavior still
requires independent audit, live token rehearsal, and production monitoring
before large balances are trusted to it.

## Implemented Contract Layer

- Immutable shared implementation proxy deployment with no developer, factory,
  admin, or proxy upgrade authority.
- ERC-4337 v0.9 validation and atomic single or batch execution.
- ERC-1271 signature validation with policy-aware restrictions.
- P-256/WebAuthn passkey validator.
- Multi-passkey threshold/MFA validator.
- Bounded session permissions and granular session permissions.
- Policy hook for low-risk classification, token limits, and paymaster
  restrictions.
- Guardian recovery with visible delay, cancellation, expiry, and complete
  validator-set replacement.
- Single-guardian emergency freeze without spending authority.
- Provider-independent direct execution for supported validators.
- Delayed sovereign migration with destination code/config binding,
  cancellation, expiry, hook enforcement, and atomic execution.
- Limited ERC-7579 adapter surface with unsupported modes rejected.

## Implemented SDK Layer

Loom now includes early wallet-engine SDK packages for developers who want to
build clients without depending on Loom-operated infrastructure:

- `@loom/account` builds local lifecycle intents for deployment, sessions,
  recovery, migration, vault withdrawal, private vault binding, paymaster
  policy, and typed lifecycle calldata encoding.
- `@loom/privacy` provides a Kohaku-compatible host boundary with explicit
  provider consent, metadata budgets, local scan state, and privacy adapter
  wrappers.
- `@loom/sdk` combines the account and privacy layers into a developer-facing
  wallet engine with `createLoomClient`, app-scoped sessions,
  `sendCalls`, `sendCallsAndWait`, gas estimation, receipt waiting,
  explicit bundler transport, passkey signer boundary, middleware hooks,
  viem-compatible call shaping, and private-vault operation binding.

The SDK deliberately does not choose a default RPC, bundler, paymaster,
relayer, signer, recovery coordinator, or privacy provider. Those adapters must
be supplied by the wallet developer or user.

## Examples

Runnable, self-verifying scripts in [`examples/`](examples/README.md) show how
to build a client on the SDK without any Loom-operated service:

- [`examples/enterprise-onboarding.mjs`](examples/enterprise-onboarding.mjs) — a
  fintech embeds a self-custody wallet into its own product: the institution
  owns onboarding, KYC, fiat rails, and infrastructure, while the user's passkey
  keeps authority and the account stays controllable even if the institution
  disappears. See the [enterprise integration guide](docs/guides/enterprise-integration.md).
- [`examples/individual-passkey-wallet.mjs`](examples/individual-passkey-wallet.mjs) —
  the same core serving one person with a passkey and self-chosen guardian
  recovery.

Each script installs a global-`fetch` trap, so a hidden default-provider call
would fail the run — the walkaway guarantee, demonstrated.

## What Is Intentionally Not In Core

These are important, but they should not be embedded into the immutable account
core before their trust and privacy assumptions are mature:

- privacy protocol adapters;
- viewing key systems;
- cross-chain config synchronization;
- L1 keystore proof verifiers;
- ZK guardian setup proofs;
- hosted recovery coordination;
- default paymaster logic;
- mandatory module registries.

Each can become an optional, audited layer when it preserves the walkaway test.

## Security Status

Loom is **pre-audit** software. Do not use it to secure production assets.

Current evidence includes unit tests, EntryPoint integration tests, fuzz tests,
stateful invariants, gas snapshots, static checks, and selected Halmos formal
properties. These are useful evidence, not a claim of complete correctness.

Before production use, Loom needs independent audit, live multi-bundler
testing, browser and hardware passkey fixture coverage, public deployment
rehearsals, stronger formal coverage, and a funded bug bounty.

## Development

```sh
npm ci
npm run verify:quick
```

Node.js 22 and Foundry v1.7.1 are the supported development baseline.
`npm run verify:quick` runs formatting, linting, production size checks, gas
snapshot checks, tests, and source-policy checks. `npm run verify` additionally
runs the CI fuzz and invariant profile.

## Documentation

- [Website source](docs/site/pages/index.mdx)
- [Documentation index](docs/README.md)
- [Product principles](docs/project/principles.md)
- [Design foundations](docs/project/foundations.md)
- [Roadmap](docs/project/roadmap.md)
- [Architecture](docs/design/architecture.md)
- [Execution model](docs/design/execution.md)
- [Authentication](docs/design/authentication.md)
- [Permissions](docs/design/permissions.md)
- [Recovery](docs/design/recovery.md)
- [Threat model](docs/security/threat-model.md)
- [Security assumptions and residual risks](docs/security/assumptions-and-risks.md)
- [Production readiness gates](docs/security/production-readiness.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Licensed under the MIT License.
