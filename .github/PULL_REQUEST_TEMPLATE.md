<!--
Title format: type(optional-scope): lowercase description

Choose a scope that names the smallest affected area, not the implementation
technique. Common scopes:

account, execution, recovery, guardian, validator, passkey, session, hook,
factory, paymaster, entrypoint, erc7579, formal, test, gas, actions, tooling

Examples:
  feat(session): add call-count permissions
  fix(recovery): reject duplicate guardian approvals
  refactor(account): isolate execution mode decoding
  perf(validator): reduce passkey verification gas
  ci(actions): enforce pull request titles

Omit the scope only when the change genuinely affects the repository as a
whole, for example: docs: document release process
-->

## Motivation

<!-- Why is this change necessary? Describe the user, security, maintenance, or
interoperability problem. Link an issue or decision record when applicable. -->

## Description

<!-- Explain what changed and the important design decisions. Prefer observable
behavior and reviewer-relevant details over a file-by-file summary. -->

## Scope

<!-- State what this pull request intentionally includes and excludes. Keep
unrelated refactors and documentation changes in separate pull requests. -->

**Included**

-

**Not included**

-

## Security impact

<!-- Describe changes to authority, trust assumptions, external dependencies,
recovery, privacy, EntryPoint behavior, or compatibility. Write "None" only
after considering each category. -->

## Verification

<!-- List the exact commands, tests, symbolic properties, benchmarks, or manual
checks used to verify the change. Include relevant gas and bytecode deltas. -->

-

## Residual risks

<!-- State what remains unproven, intentionally deferred, or dependent on an
external assumption. -->

## Review notes

<!-- Direct reviewers to the highest-risk decisions or most important files.
Remove this section when no special review guidance is needed. -->

## Checklist

- [ ] This pull request has one reviewable purpose
- [ ] Tests cover the changed behavior and important failure paths
- [ ] `npm run verify` passes
- [ ] Gas and bytecode changes are measured or not applicable
- [ ] Security assumptions and residual risks are explicit
- [ ] Documentation is unchanged or tracked in a separate `docs:` pull request
- [ ] Branch history is clean: no `Merge branch 'main' into ...` commits
