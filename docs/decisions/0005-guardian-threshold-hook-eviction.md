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

Add `evictHookWithGuardians(address hook, address replacement, GuardianApproval[] guardianApprovals)`.
The guardian threshold (never a single guardian, to avoid recreating the
single-guardian freeze griefing risk in a new spot) can uninstall one hook
immediately, with no additional delay. This mirrors the existing
`cancelMigrationWithGuardians` pattern exactly: same EIP-712
digest-over-guardian-approvals shape, immediate execution, because reaching
guardian-threshold consensus to *remove* (never install) a hook is itself the
security bar.

**Amended 2026-07-30.** The function originally could only uninstall a hook. That
was unsafe for the configuration this record's own evidence never exercised: every
built-in primary validator binds a policy hook and fails closed when that hook is
not installed, so evicting the hook the account's only validator depended on left
the account unable to authorize anything. `setPolicyHook` needs a scheduled
self-call that only a passing validator can reach, and guardian recovery installs
validators but not hooks, so nothing could repair it. The state was terminal.

The eviction now takes a `replacement`. When a validator depends on the hook a
replacement is required. The account installs it, temporarily enters the existing
scheduled-configuration context, removes the old hook, and rebinds every dependent
validator onto the replacement. The transaction is atomic: any failed rebind rolls
back the removal and installation. Eviction without a replacement remains
available when nothing depends on the hook. `_uninstallModule` refuses to remove a
depended-on hook on every ordinary path, so scheduled uninstall is guarded too.

Rebinding is reachable only while the account reports scheduled-configuration
execution. Guardian eviction raises that existing flag only around the atomic
remove-and-rebind section. Outside those contexts, rebinding would be an instant,
untimelocked way to point a validator at a permissive hook, which
`setPolicyHook`'s configuration delay exists to prevent.

This amendment enforces dependency coherence at removal time. It deliberately
does not add a new construction- or installation-time coherence rule: existing
factory, SDK, and recovery compatibility remain unchanged, and a validator naming
an absent hook continues to fail closed. Clients should reject incoherent initial
module sets before deployment. A broader on-chain installation rule requires a
separate compatibility decision because recovery must remain able to replace a
compromised validator even when the replacement configuration is incomplete.

The residual this amendment accepts, stated plainly: the guardian threshold now
chooses the contract that gates direct execution, because `isLowRisk` on the
policy hook is the only authorization gate `validateDirectExecution` consults in
`ECDSAValidator`, `P256Validator`, and `MultiP256Validator`. That is more than
the "guardians can cancel, never act" line the rest of the design holds to. It is
accepted because the same threshold can already replace every validator through
`recoverConfiguration` and so can already take the account; the delta is that
recovery is visible for three days before it applies and this is immediate. An
owner unwilling to grant that immediate lever should set the guardian threshold
so that reaching it is equivalent to consenting to recovery.

Beyond installing the replacement it names, the function still cannot move funds
or change guardian/validator configuration, and works the same way during an
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
  immediately (`test/integration/Migration.t.sol:testGuardianThresholdCanEvictAStuckHookImmediately`).
- **Amended:** that test uses `MockValidator`, which declares no policy hook, so
  it never exercised a validator bound to the evicted hook -- the configuration
  that made eviction dangerous. `test/regression/ValidatorHookDependency.t.sol`
  covers it with a real bound validator: eviction without a replacement is
  refused, eviction with one swaps atomically and leaves the account able to
  validate, the scheduled uninstall path is refused as well, and untimelocked
  rebinding is rejected outside a configuration context.

## Rejected Alternatives

- Generic `cancelScheduledWithGuardians` for any scheduled operation: rejected
  for this change because it is broader than the specific DoS risk being
  closed; tracked separately as an open design question. (Since added; see
  `docs/design/lifecycle.md`.)
- Letting a validator fall back to "no policy hook" when its bound hook is
  missing: rejected. It would turn a liveness failure into a policy bypass, which
  is the opposite of the fail-closed behaviour the validators are built on.
- Blocking hook eviction outright when a validator depends on the hook: rejected.
  It would recreate the stuck-hook denial this record exists to solve, since a
  malicious hook could make itself unremovable simply by being depended on.
- Lowering `MIN_CONFIG_DELAY` for hook removal generally: rejected because it
  would weaken the delay for every hook removal, not only a stuck one, and
  removes the visibility window for legitimate removals.
