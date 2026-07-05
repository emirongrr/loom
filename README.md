# Loom

**Loom is an immutable self-sovereign account infrastructure for Ethereum that enables modern wallet experiences without sacrificing user ownership**

Loom provides the immutable account layer that underpins wallets, fintech platforms, institutions, and developer applications across Ethereum. It standardizes the account's security model while allowing each product to define its own user experience, infrastructure, and operational architecture.

A fintech can integrate Loom into its existing application, allowing users to authenticate with passkeys while abstracting away the complexity of blockchain. A privacy-focused wallet can build on the same account layer to deliver a fully self-sovereign experience. Both inherit the same immutable security guarantees while remaining free to design entirely different user experiences.

Loom intentionally keeps the immutable core as small as possible. Everything that does not need to live forever—authentication methods, recovery mechanisms, permission systems, privacy layers, and future capabilities—is built as modular, replaceable components. This allows accounts to remain stable while security models evolve, giving users control over how their accounts adapt over time rather than locking them into a single platform's decisions.

A user's account should outlive every product and infrastructure provider built around it.

## Vision

Ethereum gave users ownership of digital assets.

The next step is giving them ownership of their digital accounts.

An account should not belong to a wallet application, an infrastructure provider, or a company. It should belong to the person who created it.

Applications should compete on user experience—not on controlling user accounts.

Institutions should be able to deliver familiar consumer experiences without becoming custodians.

Users should be able to change wallets, infrastructure providers, authentication methods, recovery mechanisms, and future security models without replacing the account they ultimately trust.

Loom exists to make that future practical.

## The Problem

Custodial platforms simplify onboarding by introducing trust.

Traditional self-custody preserves ownership but transfers operational complexity to users through seed phrases, fragmented tooling, difficult recovery, and inconsistent security models.

Replacing seed phrases with company accounts, hosted recovery services, or mandatory infrastructure dependencies does not eliminate trust—it simply changes who users are required to trust.

Developers repeatedly solve the same account problems while applications become tightly coupled to specific wallets, providers, and infrastructure.

As a result, accounts are often less durable than the products built around them.

Loom treats this as an architectural problem—not a user experience problem.

## Principles

Every design decision in Loom is derived from a small set of principles.

### Users own accounts

Accounts belong to users—not applications, companies, or infrastructure providers.

### Security before convenience

Convenience may improve, but security guarantees must not weaken.

### Keep the trusted core small

The immutable foundation should remain as small and as simple as possible. Everything else should evolve independently.

### Modular over monolithic

Capabilities should be composed through narrowly scoped modules rather than embedded into a permanently trusted core.

### Infrastructure must remain replaceable

Wallets, SDKs, bundlers, paymasters, RPC providers, recovery coordinators, and hosted services should all be replaceable without changing the account.

### Explicit authority

Every validator, policy, recovery module, and execution path should have a clearly defined scope.

Nothing should receive more authority than it requires.

### Explicit trust assumptions

Every security assumption should be visible, understandable, and independently auditable.

### Privacy is part of security

Ownership is weakened when users are forced to reveal more information than necessary.

Privacy should be achieved through explicit, auditable mechanisms—not trusted intermediaries.

### Open ecosystems over closed platforms

Products should compete through user experience—not by locking users into proprietary account infrastructure.

### Exit must always remain possible

No application, infrastructure provider, recovery service, or organization should become a permanent dependency.

Users should always be able to migrate, replace providers, and continue using their accounts without asking for permission.

### Reference implementations are not requirements

Loom may provide implementations for common account capabilities, but they are never the only valid implementations.

Builders are free to replace them.

Users are free to leave them.

## What Loom Is

Loom is an account infrastructure for Ethereum.

It provides the immutable foundation upon which wallets, fintechs, institutions, and developer applications can build secure account experiences without inheriting ownership of user accounts.

Rather than prescribing wallet interfaces, authentication flows, recovery experiences, or infrastructure choices, Loom standardizes the security boundaries every product depends on while leaving product design entirely to the builder.

At its core, Loom consists of immutable smart accounts and a deliberately small trusted foundation. Authentication, authorization, recovery, spending policies, privacy capabilities, and future extensions are designed as independent modules that can evolve without changing the account itself.

This separation allows products to innovate rapidly while the account users ultimately trust remains stable, auditable, and predictable.

Loom is infrastructure—not an application.

It provides the account.

Builders create the experience.

Users remain in control.

## What Loom Is Not

Loom is not a wallet application.

It is not a hosted service.

It does not require a Loom-operated frontend, SDK, bundler, paymaster, RPC provider, recovery coordinator, or infrastructure provider.

Loom defines the account—not the application built around it.

## Who It Is For

Loom is designed for builders who believe account ownership should remain with the user, regardless of the product built around it.

### Individuals

Build privacy-first, self-sovereign wallets with passkeys, modular recovery, explicit permissions, and long-term account ownership without relying on custodial services or proprietary infrastructure.

### Wallet Developers

Focus on user experience instead of rebuilding account security. Loom provides the immutable account foundation while remaining compatible with different interfaces, authentication methods, infrastructure providers, and future security models.

### Fintechs

Embed self-custody into existing products without exposing users to the complexity of blockchain. Users can authenticate with familiar technologies such as passkeys while institutions retain full control over onboarding, compliance, payments, and customer experience—without becoming custodians.

### Institutions

Build secure account experiences on an auditable, open foundation without introducing permanent platform dependencies. Integrate existing compliance, operational, and security workflows while allowing users to retain authority over their accounts.

### Developers & Infrastructure Providers

Build validators, recovery modules, policy engines, privacy systems, SDKs, and other account capabilities as independent, composable components rather than extensions of a closed ecosystem.

### Autonomous Agents

Execute narrowly scoped operations through explicit, revocable permissions without granting unrestricted access to user accounts.

## Privacy

Loom treats privacy as a security property, not an optional feature.

Ownership is weakened when every application relationship, balance query, recovery contact, or transaction history becomes permanently observable. A secure account should minimize unnecessary information disclosure while remaining transparent about its trust assumptions.

For this reason, Loom avoids embedding provider-controlled identity systems, mandatory global registries, or other irreversible sources of account linkage into the account layer itself. Privacy capabilities should evolve through modular, auditable components rather than permanent protocol assumptions.

As privacy technologies mature, Loom aims to support them without requiring users to replace the accounts they already trust.

## Architecture

Loom is intentionally designed around a small immutable account core.

Long-term account authority belongs to the account itself. Capabilities that naturally evolve over time—authentication, recovery, permissions, privacy, and future security models—remain independent from that core.

Rather than continuously expanding the trusted computing base, Loom minimizes it.

### Immutable Account Layer

The account is the permanent trust anchor.

It defines ownership, execution, and the security boundaries that should remain stable throughout the account's lifetime.

The account should survive changes in wallets, authentication methods, infrastructure providers, recovery mechanisms, and future protocol evolution.

### Authorization Layer

Authentication is independent from ownership.

Validators, passkeys, session permissions, spending policies, and future authorization models exist as narrowly scoped components with explicit authority.

New authentication methods should not require redesigning the account itself.

### Recovery Layer

Recovery is a security policy—not an ownership transfer.

Loom treats recovery as a modular capability with explicit authority, observable state transitions, and bounded permissions.

Recovery mechanisms can evolve independently while preserving the same underlying account.

### Privacy Direction

Privacy is treated as a security property rather than a cosmetic feature.

The immutable account layer intentionally avoids embedding provider-controlled identity systems, mandatory global registries, or irreversible account-linking mechanisms.

Future privacy capabilities should remain modular, independently auditable, and explicit about their guarantees, assumptions, and limitations.

### Verification Direction

Ethereum L1 is intended to remain the long-term root of account authority.

As the ecosystem evolves, trust-minimized verification across execution environments can be added without changing the underlying account model.

Cross-chain verification should be based on cryptographic proofs—not trusted operators, multisigs, or proprietary infrastructure.

Until that proof layer is specified and audited, Loom keeps account configuration local per chain. That is less magical, but safer.

### Everything Else

Wallets, mobile applications, browser extensions, SDKs, frontends, bundlers,
paymasters, RPC providers, relayers, hosted recovery services, analytics,
compliance systems, and enterprise integrations are not part of Loom's trusted
architecture.

Loom defines the account. Everything around it belongs to the ecosystem.

## Design Guarantees

Loom intentionally limits what the protocol is allowed to do.

These constraints are architectural guarantees rather than implementation details.

### Immutable Core

The account implementation is immutable.

There are no privileged upgrade paths, mutable implementation slots, administrator-controlled execution logic, or hidden ownership transfers.

### User Ownership

Users remain the ultimate authority over their accounts.

No company, application, infrastructure provider, or recovery service should become a permanent dependency.

### Explicit Authority

Every validator, recovery module, permission system, and policy operates within a clearly defined scope.

Authority should always be explicit, observable, and independently auditable.

### Least Privilege

Every component should receive only the authority necessary to perform its task.

Capabilities are intentionally separated to minimize the impact of compromise.

### Replaceable Infrastructure

Wallets, SDKs, frontends, bundlers, paymasters, RPC providers, and recovery coordinators are implementation choices—not trust assumptions.

Users should be able to replace them without replacing their accounts.

### Fail Closed

Unsupported execution modes, unknown authorization flows, invalid permissions,
and unexpected execution paths all fail safely.

Loom prefers rejecting behavior over interpreting undefined behavior.

### Independent Verification

Account state should remain independently verifiable.

Users should never need to trust Loom-operated infrastructure to determine the security of their own accounts.

### Walkaway Guarantee

The strongest guarantee Loom aims to provide is simple.

A user's account should remain usable, recoverable, and verifiable even if:

- the Loom organization disappears;
- every official wallet disappears;
- every official SDK disappears;
- every official frontend disappears;
- every Loom-operated service disappears.

The account—not the platform—is the permanent trust anchor.

## Current Status

Loom is under active development.

The immutable account layer, authorization framework, recovery architecture, migration system, and developer SDKs are implemented and continuously refined through extensive testing and security review.

This repository contains the on-chain account and authorization layer plus
early local SDK packages for wallet builders. It does not contain the future
mobile wallet, fintech-style user experience, production private transfer
system, light client, cross-chain router, or hosted infrastructure.

The project intentionally prioritizes architectural correctness over feature velocity.

Security, simplicity, and long-term maintainability take precedence over shipping features quickly.

Every new capability is evaluated against the project's core principles before becoming part of the trusted ecosystem.

### Implemented Today

#### Account Layer

- Immutable smart accounts with no developer, factory, admin, or proxy upgrade authority
- ERC-4337 v0.9 validation and atomic single or batch execution
- ERC-1271 signature validation with policy-aware restrictions
- Provider-independent direct execution for supported validators
- Limited ERC-7579 adapter surface with unsupported modes rejected

#### Authentication

- WebAuthn / P-256 passkeys
- Multi-passkey threshold/MFA validation

#### Authorization

- Bounded and granular session permissions
- Granular execution policies
- Spending policies
- Paymaster restrictions

#### Recovery

- Guardian recovery with visible delay, cancellation, and expiry
- Complete validator-set replacement
- Single-guardian emergency freeze without spending authority

#### Migration

- Delayed sovereign migration with destination code/config binding
- Cancellation and expiry
- Atomic migration execution with hook enforcement

#### SDK

- Local account SDK (`@loom/account`)
- Wallet engine SDK (`@loom/sdk`)
- Privacy SDK foundations (`@loom/privacy`)

The SDK deliberately does not choose a default RPC, bundler, paymaster,
relayer, signer, recovery coordinator, or privacy provider. Those adapters must
be supplied by the wallet developer or user.

## Roadmap

Loom's long-term direction follows a simple principle:

> **Expand capabilities without expanding trust.**

Future work includes:

- vault-oriented account architecture;
- privacy-preserving account capabilities;
- trust-minimized cross-chain verification;
- verified local state access;
- additional authorization primitives;
- additional recovery mechanisms;
- broader Ethereum standards support;
- broader interoperability across execution environments.

Whenever possible, new functionality should be implemented as modular, independently auditable components rather than expanding the immutable core.

Roadmap items are direction, not shipped capability. Each one still requires
independent audit and rehearsal before production trust — vault behavior in
particular needs independent audit, live token rehearsal, and production
monitoring before large balances are trusted to it.

## Examples

The [`examples/`](examples/README.md) directory demonstrates how the same Loom
account can power fundamentally different products while preserving the same
security model:

- **Embedded Fintech** — integrate self-sovereign accounts into an existing
  application while abstracting blockchain complexity behind familiar
  authentication such as passkeys. Implemented:
  [`examples/enterprise-onboarding.mjs`](examples/enterprise-onboarding.mjs)
  ([integration guide](docs/guides/enterprise-integration.md)).
- **Consumer Wallet** — build a privacy-first wallet focused on individual
  ownership and modular recovery. Implemented:
  [`examples/individual-passkey-wallet.mjs`](examples/individual-passkey-wallet.mjs).
- **Enterprise Integration** — combine institutional onboarding and compliance
  workflows with user-controlled account ownership. Partially covered by the
  fintech example; a dedicated example is
  [planned](examples/README.md#planned-examples).
- **Custom Authorization** — compose validators, policies, and recovery modules
  to create application-specific security models.
  [Planned](examples/README.md#planned-examples).

Each implemented script is runnable and self-verifying, and installs a
global-`fetch` trap: a hidden default-provider call would fail the run — the
walkaway guarantee, demonstrated.

Every example demonstrates the same architectural principle:

> **Different products. Different user experiences. The same account.**

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

Every change is expected to include appropriate testing, documentation, and
review before becoming part of the immutable account layer. Contributions that
simplify the trusted core, improve auditability, strengthen modularity, or
reduce unnecessary trust assumptions are strongly encouraged.

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
