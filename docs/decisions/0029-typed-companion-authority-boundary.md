# Keep typed companions passive and account-scoped

Status: accepted
Date: 2026-09-02

## Problem

`LoomAccount` currently stores and executes both scheduled calls and sovereign
migrations. Moving their records into companion contracts can recover runtime
margin, but a companion that can call arbitrary account execution would create
a second authority boundary and contradict the account's walkaway guarantees.

The extraction boundary must reduce account bytecode without turning a shared
controller, deployer, administrator, or off-chain service into asset authority.

## Evidence

The Phase 0 baseline records a 24,454-byte runtime with only 122 bytes of
EIP-170 margin. `LoomAccount.scheduleCall` and `LoomAccount.scheduleMigration`
are account-only entry points. `LoomAccount.executeScheduled` and
`LoomAccount.executeMigration` are permissionless only after the account checks
the committed operation, timing, freeze state, configuration version, and
execution-specific conditions. The account also owns hook execution and the
final asset call.

The detailed attack analysis is recorded in
[`typed-companion-threat-model.md`](../security/typed-companion-threat-model.md).

## Options

1. Give a companion a generic callback into account execution. Rejected because
   a controller defect would become unrestricted asset authority.
2. Let companions execute calls and ask the account to approve them. Rejected
   because it duplicates hook, freeze, and reentrancy enforcement across trust
   boundaries.
3. Use passive, typed, account-scoped ledgers that the account pulls from.
   Selected because the account remains the only execution boundary.
4. Keep every state machine in the account. Safe but rejected as the only plan
   because it leaves insufficient bytecode margin for security maintenance.

## Decision

Each companion implements one lifecycle only. It stores records under the
calling account and exposes typed schedule, cancel, read, and consume functions.
It has no generic target, calldata execution, delegatecall, account callback,
administrator, upgrade path, or mutable implementation selector.

Scheduling and ordinary cancellation are accepted only from `msg.sender`, which
is the account whose namespace is mutated. A permissionless actor asks the
account to execute; the account performs its checks and calls the companion
itself. The companion therefore consumes only the calling account's record and
never accepts an arbitrary account parameter for a state-changing operation.

Every record binds its complete typed action, source configuration version,
chain domain, readiness, expiry, and monotonic instance nonce. Consumption
clears the active record and advances its nonce before control returns to the
account. If later account execution reverts, transaction atomicity restores the
record and permits a safe retry.

The account retains risk classification, freeze checks, guardian policy, live
configuration, destination code and configuration checks, hooks, reentrancy
protection, and final asset execution. A companion may enforce global timing
bounds but may not select a lower risk tier.

Companion addresses are immutable properties of a reviewed account generation.
Changing a companion requires a new implementation and factory profile, never
a mutable storage slot or administrator action.

## Residual risks

A controller bug can incorrectly admit, reject, consume, or retain a record.
Exact commitments and account-scoped state prevent that bug from directly
widening execution, but denial of service remains possible. Additional external
calls increase gas and create a new deployment dependency. Each concrete
controller therefore requires behavior-equivalence tests, adversarial
multi-account tests, bytecode and gas measurements, and reproducible deployment
evidence before account wiring is accepted.
