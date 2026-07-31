# Formal-Style Property Tests

This directory contains formal-style symbolic property tests for Loom's account
initialization, authority, execution, recovery, migration, and immutable proxy
boundaries.

These tests are intended for Halmos or Kontrol-style symbolic execution and
are also kept compatible with Foundry. They are not complete mathematical
formal verification, theorem-prover proofs, or a claim that Loom is fully
correct. They are one evidence layer alongside unit tests, fuzzing, invariants,
static analysis, review, deployment rehearsals, and audit.

## Test Types

| File | Type | Purpose |
|---|---|---|
| `FormalHelpers.sol` | Harness helpers | Minimal symbolic fixtures used by the property contracts. |
| `LoomAccountInitializationFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact initializer/direct-execution errors, complete authority rollback, immutable proxy storage initialization, and exact absent upgrade/admin selector behavior. |
| `LoomAccountAuthorityFormal.t.sol` | Symbolic property tests | Exact authority-guard errors, privileged-call rollback, unsupported-mode target isolation, stale-schedule invalidation, and last-validator safety. |
| `LoomAccountExecutionFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact downstream failure propagation, batch atomicity, freeze errors, and direct-execution rollback behavior. |
| `LoomAccountRecoveryFormal.t.sol` | Symbolic property tests | Exact recovery-delay and frozen-account errors, complete pending-state rollback, duplicate-guardian rejection, validator replacement, and emergency cancellation carveouts. |
| `LoomAccountMigrationFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact migration rejection errors, complete pending-state rollback, call-hash binding, and batch atomicity. |
| `LoomVaultHookFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact withdrawal readiness errors, complete pending/spending/balance rollback, and guardian cancellation grants no spending authority. |
| `LoomKeystoreSyncFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact controller/sync errors, complete configuration and pending-sync rollback, and guardian-threshold cancellation grants no validator authority. |

## What these properties actually quantify over

Read the path counts Halmos reports before treating any of these as a proof over
arbitrary inputs. Of the 30 `check_` properties, 12 take no parameters at all,
and most of the parameterised ones still explore a single path — the symbolic
argument never reaches a branch, so the engine proves the statement for one
execution rather than for the argument's domain. Measured on the pinned
toolchain:

| Paths explored | Properties |
|---|---|
| 1 | 21 — the statement holds, but over one concrete execution |
| 2–3 | 8 |
| 7 | `check_InvalidDirectExecutionDoesNotConsumeNonce` |

That is not a defect on its own: an exact-revert-selector-plus-full-rollback
assertion is worth having even when it is concrete, and these files are
deliberately kept runnable as ordinary Foundry tests. It does mean the honest
description is "property tests written in a symbolic-execution-compatible
style", and that a `check_` prefix and a symbolic parameter are not by
themselves evidence that a statement was proven for all inputs.

When strengthening a property, the useful question is which input the guard
under test actually reads. `check_UnsupportedExecutionModeNeverExecutes`
originally took a `uint8 callType` and built the mode word from it, so every
mode it could express had all-zero trailing bytes — while the account's rule is
that the *whole* 32-byte word must equal one of two constants. The property
passed against a mutant that checked only the call-type byte. Quantifying over
`bytes32 mode` instead makes the same mutant produce a counterexample
(`0x0180…00`: a supported call type with a trailing byte set). That mutant is
recorded in `tools/formal/run-property-mutations.mjs`.

## Proving a property can fail

`npm run formal:mutation` breaks one guard at a time and requires the named
property to report a counterexample. A mutant costs a full recompile of the
symbolic build, so the run belongs to the formal and nightly workflows;
`verify:quick` runs `npm run formal:mutation:self-test`, which only checks the
manifest still matches the source.

Functions intended for symbolic execution use the `check_` prefix so Halmos can
discover them directly. Stateful Foundry invariant tests live outside this
directory unless a dedicated invariant harness is added here.

## Local Commands

Run the formal-style suite with Foundry:

```sh
forge test --match-path 'test/formal/*.sol'
```

Run the same suite with the CI fuzz profile:

```sh
FOUNDRY_PROFILE=ci forge test --match-path 'test/formal/*.sol'
```

Run a single Halmos target:

```sh
halmos --contract LoomAccountExecutionFormal
```

Run all current Halmos targets:

```sh
halmos --contract LoomAccountInitializationFormal
halmos --contract LoomAccountAuthorityFormal
halmos --contract LoomAccountExecutionFormal
halmos --contract LoomAccountRecoveryFormal
halmos --contract LoomAccountMigrationFormal
halmos --contract LoomVaultHookFormal
halmos --contract LoomKeystoreSyncFormal
```

For deeper local runs, use the Foundry deep profile:

```sh
FOUNDRY_PROFILE=deep forge test --match-path 'test/formal/*.sol'
```

## CI Scope

Pull requests run bounded Foundry fuzz/invariant checks and bounded Halmos
symbolic property checks. Nightly verification uses heavier Foundry settings
and longer Halmos time budgets.

If a property starts requiring unbounded symbolic search, split it into smaller
properties or move it to a manually triggered/nightly profile. PR checks should
remain useful for regular development.
