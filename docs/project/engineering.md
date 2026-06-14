# Engineering Practices

Loom's engineering method emphasizes observation, measurement, frequent
iteration, simplicity, dogfooding, and process appropriate to the project's
maturity. Process exists to shorten feedback and expose risk, not to create
the appearance of certainty.

## Working principles

| Principle | Loom practice | Evidence |
|---|---|---|
| Observe and measure | Define a before/after metric for each security or performance change | coverage, gas snapshot, bytecode size, fuzz/invariant counts |
| Iterate frequently | Land vertical behavior slices with their tests and docs | account, session, recovery, and EntryPoint lifecycle tests |
| Speak openly | Keep limitations and release blockers visible | `docs/security/assumptions-and-risks.md`, `docs/security/production-readiness.md` |
| Keep it simple | Immutable core, narrow modules, rejected unsupported modes | `docs/design/architecture.md`, `docs/design/execution.md` |
| Dogfood | One-command local core verification; CI adds coverage, static analysis, and formal checks | `npm run verify:quick`, `npm run verify`, `.github/workflows` |
| Generalize last | Add profiles and adapters only after a concrete repeated need | limited ERC-7579 profile and bounded validators |
| Add process when mature | Use release gates and dependency-ordered slices now that the prototype works | `release-plan.md` |

## Product quality scorecard

Every release candidate records:

- all normal and CI-profile tests passing;
- symbolic property count and result;
- production source line and branch coverage;
- `LoomAccount` runtime bytecode size;
- gas snapshot changes with explanations;
- static-analysis high-severity result;
- dependency vulnerability result;
- browser/device and live-bundler matrix completion;
- unresolved release blockers.

Metrics are signals, not targets to game. A test or abstraction that raises a
number without reducing uncertainty is not progress.

## Decision threshold

A decision record is required when a change affects authority, immutability,
privacy, recovery, EntryPoint trust, external-service dependency, cryptographic
verification, or a published compatibility claim. The record must state the
problem, measured evidence, considered options, decision, and residual risks.
Use the deliberately small template in `docs/decisions/README.md`.
