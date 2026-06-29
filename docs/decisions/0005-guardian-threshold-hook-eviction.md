# Decision 0005: Guardian-Threshold Immediate Hook Eviction

## Status

Accepted.

## Context

Hooks run unconditionally on every unscheduled `execute()`/`executeDirect()`
call. A reverting or unresponsive hook blocks ordinary fund movement until the
scheduled removal path (`scheduleCall` targeting the hook, gated by
`MIN_CONFIG_DELAY`, 3 days) clears. No faster guardian-driven override existed;
`freeze()` only restricts execution further and does not help recover from a
stuck hook.

## Decision

Add `evictHookWithGuardians(address hook, GuardianApproval[] guardianApprovals)`.
The guardian threshold (never a single guardian, to avoid recreating the
single-guardian freeze griefing risk in a new spot) can uninstall one hook
immediately, with no additional delay. This mirrors the existing
`cancelMigrationWithGuardians` pattern exactly: same EIP-712
digest-over-guardian-approvals shape, immediate execution, because reaching
guardian-threshold consensus to *remove* (never install) a hook is itself the
security bar.

The function can only uninstall a hook — it cannot install one, move funds, or
change guardian/validator configuration — and works the same way during an
active freeze as `cancelMigrationWithGuardians` does, since it draws on
guardian-threshold authority rather than the self-call/freeze-gated `execute()`
path.

## Consequences

Positive:

- Closes the single most consequential authority gap identified by review: a
  bad hook no longer forces a mandatory multi-day wait on ordinary fund
  movement when guardians are available to act.

Risks:

- A second, narrower immediate-action authority surface now exists alongside
  `cancelMigrationWithGuardians`. The asymmetry with recovery-module eviction
  (no equivalent guardian fast path) is intentional — see the rationale in
  `docs/design/execution.md`'s "Guardian hook eviction" section — but should be
  revisited if a similar DoS-class risk is found for another module type.

Required controls:

- Test coverage proving a below-threshold approval is rejected and a
  threshold approval evicts the hook and restores normal execution
  immediately (`test/SovereignMigration.t.sol:testGuardianThresholdCanEvictAStuckHookImmediately`).

## Rejected Alternatives

- Generic `cancelScheduledWithGuardians` for any scheduled operation: rejected
  for this change because it is broader than the specific DoS risk being
  closed; tracked separately as an open design question.
- Lowering `MIN_CONFIG_DELAY` for hook removal generally: rejected because it
  would weaken the delay for every hook removal, not only a stuck one, and
  removes the visibility window for legitimate removals.
