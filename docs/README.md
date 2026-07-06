# Documentation

Loom's documentation is organized so new readers can learn the project before
diving into protocol details. The README is the public entry point. This index
is the learning map. Design, security, operations, and decisions are the
authoritative places for deeper detail.

## Learning Path

1. **Understand the project**
   - [Design foundations](project/foundations.md)
   - [Product principles](project/principles.md)
   - [Who Loom is for](project/audiences.md)

2. **Separate code from roadmap**
   - [Implementation status](status.md)
   - [Roadmap](project/roadmap.md)
   - [Release plan](project/release-plan.md)

3. **Learn the architecture**
   - [System diagrams](design/system-diagrams.md)
   - [Architecture](design/architecture.md)
   - [Account lifecycle](design/lifecycle.md)
   - [Execution model](design/execution.md)

4. **Review authority and safety**
   - [Threat model](security/threat-model.md)
   - [Assumptions and residual risks](security/assumptions-and-risks.md)
   - [Audit scope](security/audit-scope.md)
   - [Production readiness](security/production-readiness.md)

5. **Inspect code and tests**
   - Contracts: [`../src/`](../src/)
   - Tests: [`../test/`](../test/)
   - SDK packages: [`../packages/`](../packages/)
   - Formal material: [`../formal/`](../formal/)

## Documentation Responsibilities

| Area | Purpose |
| --- | --- |
| `README.md` | Concise public overview, current status, repository map, and learning path. |
| `docs/README.md` | Documentation index and reading order. |
| `docs/status.md` | Truth table for implemented, partial, boundary, planned, and missing features. |
| `docs/design/` | Technical architecture and design rationale. |
| `docs/security/` | Threat model, assumptions, residual risks, audit scope, and release gates. |
| `docs/decisions/` | Durable records explaining authority, trust, privacy, and compatibility choices. |
| `docs/operations/` | Deployment, rehearsal, profile, and evidence requirements. |
| `docs/site/` | Website shell and public docs pages; it should summarize and link, not fork the source of truth. |

## Design

- [System diagrams](design/system-diagrams.md)
- [Architecture](design/architecture.md)
- [Account lifecycle](design/lifecycle.md)
- [Execution model](design/execution.md)
- [Authentication](design/authentication.md)
- [Permissions](design/permissions.md)
- [Recovery](design/recovery.md)
- [Guardians](design/guardians.md)
- [Vaults](design/vaults.md)
- [Global keystore](design/keystore.md)
- [Verified wallet client](design/verified-wallet.md)
- [Privacy adapters](design/privacy-adapters.md)
- [EIP-7702 delegation](design/eip-7702.md)
- [EntryPoint liveness](design/entrypoint-liveness.md)

## Security

- [Threat model](security/threat-model.md)
- [Assumptions and residual risks](security/assumptions-and-risks.md)
- [Production readiness](security/production-readiness.md)
- [Audit scope](security/audit-scope.md)
- [Formal verification](security/formal-verification.md)
- [Formal tooling on Linux](security/linux-formal-tooling.md)
- [Static analysis](security/static-analysis.md)
- [Wallet bug regression coverage](security/wallet-bug-regression.md)

## Guides

- [Enterprise integration](guides/enterprise-integration.md)

## Operations And Standards

- [Deployment and verification](operations/deployment.md)
- [Deployment manifest evidence](operations/deployment-manifest.md)
- [Keystore proof profile evidence](operations/keystore-proof-profile.md)
- [Privacy adapter profile evidence](operations/privacy-adapter-profile.md)
- [Bundler qualification](operations/bundler-qualification.md)
- [Local lifecycle rehearsal](operations/local-rehearsal.md)
- [Live lifecycle rehearsal](operations/live-rehearsal.md)
- [ERC-7579 limited profile](standards/erc-7579-profile.md)
- [WalletBeat Stage 2 matrix](standards/walletbeat-stage-2.md)

## Reviews And Decisions

- [Engineering decision records](decisions/README.md)
- [Pre-audit review, June 2026](reviews/pre-audit-2026-06.md)
- [Philosophy-grounded gap analysis, June 2026](reviews/philosophy-walletbeat-gap-analysis-2026-06.md)
- [Preliminary review disposition](reviews/preliminary-review-disposition.md)

## Documentation Rule

Do not describe a feature as implemented unless it is supported by code and
tests. If the claim is conceptual, planned, partial, experimental, or a release
gate, label it that way and link to the relevant design or security document.
