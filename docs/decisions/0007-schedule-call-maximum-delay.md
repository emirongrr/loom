# Decision 0007: Maximum Scheduled-Call Delay

## Status

Accepted.

## Context

`scheduleCall` enforced a minimum delay tier but no maximum. A fat-finger
delay value (for example, a unit confusion between seconds and days) could
schedule an operation with an unreasonably long delay. An operation scheduled
this way was already recoverable via `cancelScheduled` (no delay gate on
cancellation), so this was a UX safety-net gap, not a fund-loss bug.

## Decision

Add `MAX_SCHEDULE_DELAY` (90 days) and enforce it in `scheduleCall`.

## Consequences

Positive:

- Bounds an obviously-wrong delay value before it is committed, consistent
  with the existing `MAX_MIGRATION_WINDOW` cap on `scheduleMigration`'s
  execution window.

Risks:

- None identified; 90 days exceeds any realistic legitimate use of
  `scheduleCall`'s delay parameter while still catching gross input errors.

Required controls:

- Test coverage proving a delay above the maximum is rejected and the maximum
  itself is accepted (`test/SecurityRegression.t.sol:testScheduleCallRejectsDelayBeyondMaximum`).

## Rejected Alternatives

- Rely on `cancelScheduled` alone: rejected because requiring a user to notice
  and correct a fat-finger error after the fact is worse than rejecting the
  obviously-wrong input up front.
