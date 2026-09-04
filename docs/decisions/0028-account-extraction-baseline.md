# Pin the sovereign account extraction baseline

Status: accepted
Date: 2026-09-02

## Problem

`LoomAccount` is close enough to the EIP-170 runtime limit that adding another
security check can make the production implementation undeployable. Moving
state machines out of the account changes authority and failure boundaries, so
an extraction cannot be reviewed safely without a reproducible starting point.

## Evidence

At revision `cb6a46f6a2882b7155e1c7ae65bd3227d7ad71a8`, the production compiler
profile produces a 24,454-byte `LoomAccount` runtime, leaving 122 bytes below
the 24,576-byte EIP-170 limit. The committed protocol-surface, storage-layout,
and gas snapshots already pin three compatibility dimensions, but no single
artifact binds them to compiler inputs and bytecode hashes.

The baseline review also classifies three previously reported concerns:

- H-1 is reproduced. A target that is not installed when `scheduleCall` runs
  receives the external-call delay even if it becomes an installed module
  before execution. The account checks target classification only at schedule
  time in `LoomAccount.scheduleCall`.
- H-2 is not reproduced on this revision. `LoomAccount.executeMigration`
  rejects execution while frozen and rejects a migration after configuration
  drift. `RecoveryManagerTest.testCompositeFreezeRecoveryAndMigrationState`
  pins both properties.
- M-4 is not reproduced on the Loom-native module boundary. `ILoomModule`
  declares `isModuleType` as `pure`; ERC-7579 compatibility interfaces declare
  it as `view`. Both declarations force a read-only external call from Solidity.

## Options

1. Start extraction immediately and compare ad hoc compiler output in each
   pull request. Rejected because build drift and authority drift would be hard
   to distinguish.
2. Make the current implementation satisfy the future release margin before
   recording it. Rejected because that would mix measurement with production
   behavior changes.
3. Commit a machine-checkable baseline and a separate release-margin policy.
   Selected because it preserves the current generation while giving every
   later extraction the same comparison point.

## Decision

Commit compiler inputs, source and dependency identities, runtime and init-code
hashes and sizes, ABI and storage counts, and compatibility snapshot hashes.
The current generation remains deployable with its measured 122-byte margin.
A new sovereign account generation is not release-ready unless it has at least
2,048 runtime bytes of EIP-170 margin; 4,096 bytes is the engineering target.

H-1 is fixed in a separate behavior-changing pull request. No production source
change belongs in the baseline pull request.

## Residual risks

The baseline proves reproducibility, not behavioral correctness. Deployment and
initialization gas still require transaction-receipt evidence. Full execution
gas remains governed by `.gas-snapshot`. The release-margin command is applied
to the new implementation only after that implementation exists.
