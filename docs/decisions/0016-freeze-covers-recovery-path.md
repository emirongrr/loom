# Freeze covers the recovery path

Status: accepted
Date: 2026-07-30

## Problem

A guardian freeze is meant to hold an account still long enough for recovery to
replace a compromised validator. It did not.

`FREEZE_DURATION` was 2 days and `RecoveryManager.RECOVERY_DELAY` is 3 days, so a
guardian who froze the instant an attack was noticed lost protection about a day
before recovery became executable. `MIN_EXTERNAL_DELAY` is 1 day, so an operation
the attacker scheduled before the freeze was already ready and waiting in that
window, and `executeScheduled` is permissionless — the attacker could publish it
themselves the moment the freeze lapsed. Scheduled operations have no expiry, so
waiting cost the attacker nothing.

A second, worse path existed. `_isFrozenSafe` allows exactly one action while
frozen: cancelling this account's pending recovery on an installed recovery
module. That carve-out is deliberate, so a real owner can stop a malicious
guardian recovery even while guardians hold a freeze. But a compromised validator
inherits it, and `freeze` allows each guardian leaf only one freeze per
configuration version while `RecoveryManager._cancel` advances only its own
nonce. So the attacker could cancel the recovery from inside the freeze, reset
the guardians' 3-day clock, and exhaust the guardians' freezes while the
pre-scheduled operation waited. On a single-guardian tree this was unrecoverable.

## Evidence

Existing coverage looked adequate and was not. `RecoveryManagerTest`'s
`testGuardianFreezeProtectsRecoveryFromScheduledConfigBump` schedules a
*configuration* call, which carries the 3-day `MIN_CONFIG_DELAY` and therefore
becomes ready at the same moment recovery does — the one arrangement a 2-day
freeze happened to survive. No test used `MIN_EXTERNAL_DELAY`.
`SecurityRegression`'s `testSingleGuardianFreezeCannotBeReplayedAndBlocksExecution`
built the exact precondition, warped to freeze expiry, and then stopped without
asserting the surviving operation's fate.

`testFrozenAccountCanCancelExactRecovery` already proved the frozen cancellation
is reachable; nothing tested what the guardians could do afterwards.

`recoverConfiguration` and `recoverConfigurationSet` are gated on the caller
being an installed recovery module and do not consult `frozenUntil`. Recovery
therefore executes normally during a freeze, so lengthening the freeze delays
nothing legitimate.

## Options

- **Lengthen the freeze to cover the recovery delay plus a publication margin.**
  Smallest change that closes the timing gap. Does not by itself address the
  cancellation loop.
- **Let a guardian leaf freeze again once its previous freeze lapsed.** Rejected.
  The once-per-configuration-version rule is exactly what stops a single guardian
  from holding an account frozen forever without meeting the recovery threshold.
  Relaxing it would hand any one guardian an indefinite lock by re-freezing every
  time the window expired, which is a permanent veto and contradicts
  `DESIGN_PHILOSOPHY.md`.
- **Remove `cancelRecovery` from the frozen-safe set.** Rejected. It is the
  owner's only defence against a malicious guardian recovery while guardians hold
  a freeze. Removing it converts a guardian threshold into an account takeover.
- **Suspend scheduled execution while any recovery is pending.** Rejected. It
  puts a per-recovery-module external call on the execution hot path, so a
  misbehaving or reverting module would deny ordinary execution. The freeze window
  already provides the same protection without that liveness dependency.
- **Make the frozen cancellation advance the account configuration.** Chosen for
  the cancellation loop; see below.

## Decision

Two changes, both aimed at one property: a timely guardian freeze and recovery
initiation must prevent a compromised validator from executing an
already-scheduled operation.

`FREEZE_DURATION` becomes 5 days: `RECOVERY_DELAY` (3 days) plus a 2-day margin to
publish the recovery execution under censorship or bundler unavailability. A new
structural invariant, `invariantFreezeOutlastsRecoveryDelay`, pins
`FREEZE_DURATION - RECOVERY_DELAY >= MIN_EXTERNAL_DELAY` so the gap cannot be
reintroduced by tuning either constant.

A recovery cancellation executed *while frozen* advances the account's
configuration version. Reaching that point while frozen means `_isFrozenSafe`
accepted the call, and the only shape it accepts is cancelling this account's
pending recovery, so no other execution is affected. The advance makes the
cancellation self-defeating: it re-arms every guardian leaf, because the freeze
gate compares against `configVersion`, and it retires every pending scheduled
operation, migration, and vault withdrawal, because each binds the configuration
version it was created at. The attacker may still cancel recovery, but every
cancellation destroys the payload the freeze was buying time to stop and returns
a freeze to the guardians.

This is scoped to the frozen path. Cancelling a recovery on an unfrozen account
is an ordinary uncontested action and must not silently discard the owner's other
pending operations.

No new authority is introduced. No party gains a power it did not have; an
existing action gains a documented consequence.

Acceptance requires: a freeze taken when an external-delay operation is already
ready still protects the account at the moment the old 2-day freeze would have
lapsed, and the operation never executes; a frozen recovery cancellation advances
the configuration, retires the pending operation, and lets the same guardian leaf
freeze again and complete recovery; an unfrozen cancellation changes neither the
configuration nor the owner's pending operations; and a mutation removing the
configuration advance fails the cancellation test.

## Residual risks

A freeze alone remains a delay, not a veto. If guardians freeze but never propose
recovery, the pending operation becomes executable when the freeze lapses. That
is deliberate — a lapsed freeze that permanently retired operations would let one
guardian destroy the owner's pending work below the recovery threshold — and it
is asserted explicitly in
`testSingleGuardianFreezeCannotBeReplayedAndBlocksExecution`.

The 2-day publication margin is a judgement about censorship and bundler
availability, not a proof. An adversary who can censor an account's recovery
execution for longer than the margin still wins the race. Direct execution
through an installed direct-capable validator is the mitigation, and it does not
depend on a bundler.

Guardian-threshold cancellation of a generic scheduled operation is still
missing; every other delayed mechanism has one. It is deferred to the change that
gives scheduled operations an instance identity, because without one a
cancellation approval would be replayable against a re-scheduled operation in
exactly the way `docs/decisions` records for vault withdrawals.

The account's configuration version now advances on an event that is not a
configuration edit. Clients that treat `ConfigUpdated` as "the user changed
something" should distinguish the `FROZEN_RECOVERY_CANCELLED` change hash.
