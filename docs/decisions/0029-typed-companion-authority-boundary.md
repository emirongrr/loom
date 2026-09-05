# Keep typed companions passive and account-scoped

Status: accepted
Date: 2026-09-02

## Problem

`LoomAccount` currently stores and executes both scheduled calls and explicit
migrations. Moving their records into companion contracts can recover runtime
margin, but a companion that can call arbitrary account execution would create
a second authority boundary and contradict the account's walkaway guarantees.

The extraction boundary must reduce account bytecode without turning a shared
controller, deployer, administrator, or off-chain service into asset authority.

## Evidence

The Phase 0 baseline records a 24,454-byte runtime with only 122 bytes of
EIP-170 margin. Before extraction, migration scheduling, cancellation, record
storage, commitment helpers, and validation all lived in `LoomAccount`.
`LoomAccount.executeMigration` was already permissionless after validation,
while the account owned freeze enforcement, hooks, and final asset execution.

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

Scheduling and ordinary cancellation derive the account namespace from
`msg.sender`. Consumption accepts an account parameter only when
`msg.sender == account`; guardian cancellation accepts an explicit account only
after verifying that the module is installed there and that the account's
guardian threshold approved the exact cancellation digest. A permissionless
actor asks the account to execute, and the account consumes its own record.

Every record binds its complete typed action, source configuration version,
chain domain, readiness, expiry, and monotonic instance nonce. Consumption
clears the active record and advances its nonce before control returns to the
account. If later account execution reverts, transaction atomicity restores the
record and permits a safe retry.

The account retains freeze checks, hooks, reentrancy protection, and final asset
execution. The migration module owns timing bounds, live configuration checks,
destination code/configuration checks, commitment verification, guardian
cancellation, and nonce advancement. Policy hooks classify calls to the
installed migration module as configuration actions.

Companion replacement uses the account's existing module lifecycle and
configuration delay. No administrator or factory can replace it. A production
profile pins the reviewed module address in deployment evidence; an account may
later replace it only through its own delayed authority path.

## Residual risks

A controller bug can incorrectly admit, reject, consume, or retain a record.
The account trusts successful consumption as typed authorization. A defect in
that decision can admit an arbitrary caller-supplied batch; the installed
module is therefore part of the authorization TCB. The account still enforces
freeze, hooks, reentrancy protection, and execution bounds. Passive operation
prevents independent initiation, but does not reduce every defect to denial of
service. Additional external
calls increase gas and create a new deployment dependency. Each concrete
controller therefore requires behavior-equivalence tests, adversarial
multi-account tests, bytecode and gas measurements, and reproducible deployment
evidence before account wiring is accepted.
