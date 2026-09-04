# Typed companion threat model

## Scope

This document defines the security boundary for moving delayed-operation state
out of `LoomAccount`. It applies first to account migration and, only if the
measured benefit justifies it, scheduled-call records. It does not authorize a
generic executor or move final asset execution out of the account.

## Protected properties

1. Only the account's existing authority can schedule or ordinarily cancel its
   typed action.
2. A permissionless executor can trigger only the exact committed action after
   its delay and before its expiry.
3. One account cannot read a record and consume or cancel it as another account.
4. A consumed or cancelled instance cannot be replayed against a later record.
5. Freeze, hooks, reentrancy, and final execution remain enforced by the
   account; live record and configuration bindings remain enforced by the
   typed module.
6. No deployer, administrator, upgrade key, service, or companion can move user
   assets independently.
7. A failed final execution restores the consumed record atomically, allowing a
   safe retry inside the original execution window.

## Trust boundaries

The account is the sole execution authority. A companion is a passive typed
ledger. External callers may invoke the account's permissionless execution
entry point, but only the account calls the companion's consuming function.

Scheduling and ordinary cancellation derive the state namespace from
`msg.sender`. Consumption names an account but requires `msg.sender == account`.
Guardian cancellation names an account because guardians are external actors;
it verifies module installation and threshold approval against that account
before mutation. Read-only enumeration accepts an account address because it
grants no mutation or execution authority.

The migration module independently enforces its three-day minimum delay and
30-day maximum execution window. The account's hooks recognize only the exact
schedule and ordinary-cancel selectors on the currently installed migration
module as lifecycle calls.

## Required record bindings

Every action identifier or commitment binds:

- the typed action domain;
- the account namespace;
- `block.chainid`;
- the complete action payload or collision-resistant payload hash;
- the source account configuration version;
- readiness and expiry;
- a monotonic instance nonce.

Migration additionally binds destination, destination runtime code hash,
optional destination configuration hash, and the complete calls hash.
Scheduled calls additionally bind target, value, and calldata hash.

## Ordering

The account execution path follows this order:

1. Check the account freeze and enter the execution reentrancy lock.
2. Ask the module to load and validate the exact account-scoped record.
3. Check timing, source configuration, destination code/configuration, and the
   committed call hash inside the module.
4. Consume the record and advance its nonce.
5. Run account hook pre-checks through the shared batch execution engine.
6. Execute the exact calls from account context.
7. Run account hook post-checks and complete the transaction.

Consumption precedes asset calls to block same-transaction replay. Solidity
transaction atomicity restores companion and account state if any later step
reverts. Reentrancy protection remains active across the entire account path.

## Attack analysis

| Threat | Required defense | Failure if omitted |
| --- | --- | --- |
| Consume another account's record | `msg.sender == account` plus installed-module verification | Cross-account denial of service or action theft |
| Replay an old cancellation | Monotonic instance nonce in the approval and record | Published approval cancels future instances |
| Swap action calldata | Exact typed commitment checked at consumption and execution | Permissionless executor widens the action |
| Replay across chains | Chain domain in the commitment | Approval or record is portable to another chain |
| Execute after authority rotation | Source configuration version checked by the module | Stale authority survives recovery |
| Execute while frozen | Account checks freeze before consumption and execution | Emergency response no longer blocks asset movement |
| Malicious companion widens calls | No callback, generic executor, delegatecall, or asset custody | Controller defect becomes spending authority |
| Companion reentrancy | Account lock spans consume and final execution; recheck after consume | Nested execution observes partial lifecycle state |
| Module replacement | Account-owned delayed module lifecycle and deployment evidence | Unreviewed lifecycle semantics become active without user delay |
| Module outage or defect | Immutable source, reproducible deployment, retryable atomic failure | User action is denied until account-authorized module replacement |

## Interface review requirements

Before a companion implementation is wired into an account generation, its
interface must demonstrate all of the following:

- schedule and ordinary cancellation affect only `msg.sender` state;
- consume requires the named account to be `msg.sender`, while guardian
  cancellation verifies the named account's threshold;
- the action is represented by a domain-specific struct, not arbitrary calldata;
- consume recomputes the commitment from the stored record and supplied calls;
- events include the account and commitment identifier, with schedule events
  also exposing readiness, expiry, and the committed fields;
- no function transfers value, invokes an account, or accepts an execution
  target plus arbitrary calldata;
- no owner, role, upgrade, pause, or mutable dependency exists.

## Verification obligations

Concrete controllers require unit, fuzz, invariant, and multi-account tests for
duplicate scheduling, early and expired consumption, mismatched commitments,
configuration drift, cancellation replay, cross-account isolation, and atomic
rollback. Account wiring additionally requires behavior-equivalence vectors,
malicious-controller tests, hook and freeze regressions, runtime-size deltas,
and critical-path gas deltas against the canonical Phase 0 baseline.
