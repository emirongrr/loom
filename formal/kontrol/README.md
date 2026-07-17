# Kontrol / KEVM Targets

Kontrol is Loom's preferred deeper EVM-aligned path after Halmos because it can
reuse Solidity/Foundry-style specifications while relying on KEVM semantics.

## Status

Target manifest added. A weekly scheduled and manually triggered GitHub Actions
workflow runs the first selected KEVM/Kontrol targets. Kontrol is intentionally
not part of pull-request CI yet because first-run installation and proof times
are too heavy for normal review loops.

## Initial Targets

`targets.json` defines the first Foundry property tests that should become
Kontrol proof targets:

- `LoomAccountAuthorityFormal`
- `LoomAccountExecutionFormal`
- `LoomAccountRecoveryFormal`
- `LoomAccountMigrationFormal`

## Local Commands

After installing Kontrol through `kup` or another pinned project-approved
method:

```sh
kontrol build
kontrol prove --match-test LoomAccountAuthorityFormal.test_CannotRemoveLastValidator
kontrol prove --match-test LoomAccountExecutionFormal.testFuzz_FrozenAccountCannotExecute
kontrol prove --match-test LoomAccountRecoveryFormal.test_RecoveryDelayIsEnforced
kontrol prove --match-test LoomAccountMigrationFormal.testFuzz_MigrationHashBinding
```

The project-approved release is pinned in `formal/kontrol/version.txt`; both
the weekly workflow and Linux setup script install that exact tag. Scheduled
and manual workflow runs archive commit-bound metadata, the target manifest,
tool versions, build output, and separate proof logs for 30 days. Failed runs
upload partial evidence, but artifact presence alone is not a passing proof.

These targets are selected KEVM/Kontrol proof targets, not complete wallet
verification.

## Acceptance Gate

Before enabling a PR job:

1. Keep the release tag in `formal/kontrol/version.txt` pinned and reviewed.
2. Document expected runtime on a clean checkout.
3. Prove at least one authority property locally.
4. Add a nightly-only workflow first.
5. Move to PR CI only after the run is deterministic and fast enough.

## Claim Boundary

Kontrol results may support bytecode-level confidence for selected properties,
but they still depend on harness assumptions, bounded settings where used,
external-call modeling, and the selected target functions.
