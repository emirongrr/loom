# Contributing

Loom is security-critical pre-audit software. Small, explicit changes with
measured outcomes are preferred over broad abstractions.

## First hour

1. Read `docs/README.md`, `docs/project/principles.md`, and
   `docs/design/architecture.md`.
2. Install Node.js 22 and Foundry v1.7.1.
3. Run `npm ci`.
4. Run `npm run verify:quick`.

The quick verification command must pass before starting work. Use
`npm run verify` before requesting review.

## Change loop

1. State the user or security problem and a measurable acceptance condition.
2. Reproduce the current behavior with the smallest useful test.
3. Implement the narrowest change that satisfies the condition.
4. Run the nearest test repeatedly while iterating.
5. Run repository verification and record changed metrics.
6. Update threat, architecture, or decision documentation when an authority
   boundary or assumption changes.

## Review rules

- Findings and tradeoffs must be discussed openly and impersonally.
- New abstractions require demonstrated repeated complexity.
- New authority, dependency, external service, or mutable component requires
  a decision record and threat-model update.
- Security claims must name their assumptions and evidence.
- Generated artifacts and local secrets must not be committed.
