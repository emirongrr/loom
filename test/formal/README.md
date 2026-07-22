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
| `LoomAccountInitializationFormal.t.sol` | Symbolic and fuzz-compatible property tests | Initializer one-shot safety, delegated initializer access control, immutable proxy storage initialization, non-upgradeability selectors, and invalid direct-execution nonce rollback. |
| `LoomAccountAuthorityFormal.t.sol` | Symbolic property tests | Exact authority-guard errors, privileged-call rollback, unsupported-mode target isolation, stale-schedule invalidation, and last-validator safety. |
| `LoomAccountExecutionFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact downstream failure propagation, batch atomicity, freeze errors, and direct-execution rollback behavior. |
| `LoomAccountRecoveryFormal.t.sol` | Symbolic property tests | Exact recovery-delay and frozen-account errors, complete pending-state rollback, duplicate-guardian rejection, validator replacement, and emergency cancellation carveouts. |
| `LoomAccountMigrationFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact migration rejection errors, complete pending-state rollback, call-hash binding, and batch atomicity. |
| `LoomVaultHookFormal.t.sol` | Symbolic and fuzz-compatible property tests | Exact withdrawal readiness errors, complete pending/spending/balance rollback, and guardian cancellation grants no spending authority. |
| `LoomKeystoreSyncFormal.t.sol` | Symbolic and fuzz-compatible property tests | L1 keystore controller-only updates, sync delay enforcement, and guardian-threshold sync cancellation grants no validator authority. |

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
