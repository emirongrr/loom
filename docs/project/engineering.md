# Engineering Practices

Loom's engineering method emphasizes observation, measurement, frequent
iteration, simplicity, dogfooding, and process appropriate to the project's
maturity. Process exists to shorten feedback and expose risk, not to create
the appearance of certainty.

The repository is past the unconstrained prototype phase: the account core
works, and failures now have a meaningful security cost. Production paths
therefore require small changes, review, tests, and measured evidence.
Uncertain research may still move quickly, but it must remain clearly isolated
from production claims and immutable authority.

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

## Feedback Loops

- Begin with observation: reproduce the behavior and choose a metric or
  security property before changing code.
- Prefer the smallest end-to-end vertical slice that can be executed and
  evaluated over a large horizontal foundation.
- Merge frequently, but never use speed to bypass review or evidence for an
  authority change.
- Use small proofs of concept to reduce uncertainty. Keep them outside the
  production authority path until their assumptions and failure modes are
  understood.
- Keep pipelines readable and debuggable. A failed check must explain what
  evidence is missing.
- Dogfood independent build, deployment, recovery, direct execution, and
  walkaway procedures.

## Complexity Budget

Complexity is a security cost. A new abstraction must remove demonstrated
repeated complexity or establish a required interoperability boundary.

Repeating a small explicit pattern can be safer than introducing a general
mechanism with broader authority. Optimize only after measuring a real
requirement, and measure again after the change.

## Process By Uncertainty

Use experiments when the problem is not understood. Use milestones, dependency
ordering, release gates, and thorough review when the behavior and target are
understood. A new research problem may temporarily return to experimentation,
but experimental assumptions must not silently enter production contracts.

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
