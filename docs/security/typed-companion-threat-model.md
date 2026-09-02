# Typed companion threat model

## Scope

This document defines the security boundary for moving delayed-operation state
out of `LoomAccount`. It applies first to sovereign migration and, only if the
measured benefit justifies it, scheduled-call records. It does not authorize a
generic executor or move final asset execution out of the account.

## Protected properties

1. Only the account's existing authority can schedule or ordinarily cancel its
   typed action.
2. A permissionless executor can trigger only the exact committed action after
   its delay and before its expiry.
3. One account cannot read a record and consume or cancel it as another account.
4. A consumed or cancelled instance cannot be replayed against a later record.
5. Freeze, hooks, reentrancy, live configuration, and final execution remain
   enforced by the account.
6. No deployer, administrator, upgrade key, service, or companion can move user
   assets independently.
7. A failed final execution restores the consumed record atomically, allowing a
   safe retry inside the original execution window.

## Trust boundaries

The account is the sole execution authority. A companion is a passive typed
ledger. External callers may invoke the account's permissionless execution
entry point, but only the account calls the companion's consuming function.

The companion derives the state namespace from `msg.sender`. State-changing
functions do not accept an account address supplied by the caller. Read-only
enumeration may accept an account address because it grants no mutation or
execution authority.

The account decides whether a target requires a configuration delay. A
companion independently enforces absolute minimum and maximum timing bounds but
does not classify targets or reduce a delay selected by the account.

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

1. Load the expected record and reject absent or mismatched state.
2. Check account freeze and current configuration conditions.
3. Recheck action-specific live state, including destination code when relevant.
4. Ask the companion to consume the exact account-scoped instance.
5. Recheck any live condition that could differ across an external call.
6. Run account hook pre-checks.
7. Execute the exact calls from account context.
8. Run account hook post-checks and emit completion evidence.

Consumption precedes asset calls to block same-transaction replay. Solidity
transaction atomicity restores companion and account state if any later step
reverts. Reentrancy protection remains active across the entire account path.

## Attack analysis

| Threat | Required defense | Failure if omitted |
| --- | --- | --- |
| Consume another account's record | Namespace mutations by `msg.sender`; no mutable account parameter | Cross-account denial of service or action theft |
| Replay an old cancellation | Monotonic instance nonce in the approval and record | Published approval cancels future instances |
| Swap action calldata | Exact typed commitment checked at consumption and execution | Permissionless executor widens the action |
| Replay across chains | Chain domain in the commitment | Approval or record is portable to another chain |
| Execute after authority rotation | Source configuration version checked by the account | Stale authority survives recovery |
| Execute while frozen | Account checks freeze before consumption and execution | Emergency response no longer blocks asset movement |
| Malicious companion widens calls | No callback, generic executor, delegatecall, or asset custody | Controller defect becomes spending authority |
| Companion reentrancy | Account lock spans consume and final execution; recheck after consume | Nested execution observes partial lifecycle state |
| Controller replacement | Immutable account-generation binding | Administrator silently changes lifecycle semantics |
| Controller outage or defect | Immutable source, reproducible deployment, retryable atomic failure | User action is denied until migration to a reviewed generation |

## Interface review requirements

Before a companion implementation is wired into an account generation, its
interface must demonstrate all of the following:

- each state-changing function affects only `msg.sender` state;
- the action is represented by a domain-specific struct, not arbitrary calldata;
- consume requires an expected identifier, commitment, version, and nonce;
- events include account, identifier, nonce, readiness, expiry, and commitment;
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
