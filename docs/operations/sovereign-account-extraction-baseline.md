# Sovereign account extraction baseline

## Motivation

Core extraction moves state without moving final asset authority. Every change
must therefore show both the bytecode benefit and behavioral equivalence to the
same immutable starting point. The canonical machine-readable record is
`evidence/baselines/sovereign-account-phase0.json`.

## Commands

Regenerate the record only when intentionally selecting a new baseline:

```sh
npm run account:baseline:write
```

Validate the committed record and release policy in ordinary CI:

```sh
npm run account:baseline:test
```

On the exact baseline source tree, reproduce the compiler configuration,
dependency lock, submodules, bytecode, ABI, storage, protocol surface, and gas
snapshot:

```sh
npm run account:baseline:check
```

The exact check is intentionally not a permanent source-freshness gate. Later
extraction changes must differ from the baseline; each such pull request reports
its own delta while this historical record remains unchanged.

Apply the mandatory release margin to a proposed account generation:

```sh
node tools/evidence/sovereign-account-baseline.mjs \
  --release --target src/path/NewAccount.sol:NewAccount
```

The current `LoomAccount` intentionally fails that future-generation release
gate. It remains the compatibility baseline and is not modified by Phase 0.0.

## Pinned behavior

The extraction series must preserve the existing protocol surface and storage
snapshots. Migration equivalence is covered by `SovereignMigration.t.sol`,
`MultiAccountMigrationInvariant.t.sol`, and `LoomAccountMigrationFormal.t.sol`.
Scheduled-call equivalence is covered by `ScheduledOperationLifecycle.t.sol`
and the scheduling cases in `SecurityRegression.t.sol`.

The following authority boundaries are mandatory throughout extraction:

| Mutation | Initiation authority | Consumption authority | Delay and invalidation |
| --- | --- | --- | --- |
| Schedule generic call | Account self-call | None until scheduled | Target-dependent delay; config version binds identity |
| Execute generic call | Existing schedule commitment | Permissionless | Readiness, expiry, freeze, exact call, single use |
| Cancel generic call | Account self-call or guardian threshold | Permissionless guardian submission | Exact operation instance nonce |
| Schedule migration | Account self-call | None until scheduled | Configuration delay and bounded execution window |
| Execute migration | Existing migration commitment | Permissionless | Freeze, readiness, expiry, config, destination, and calls rechecked |
| Cancel migration | Account self-call or guardian threshold | Permissionless guardian submission | Exact migration instance nonce |
| Install or uninstall module | Account self-call | Scheduled account execution | Configuration delay |
| Replace validators through recovery | Installed recovery module | Recovery state machine | Recovery delay, expiry, and configuration binding |

H-1 remains open at this baseline: a future module target can be classified as
external when scheduled. The next pull request must add a failing-before
reproducer and fix the classification without broadening module authority.
