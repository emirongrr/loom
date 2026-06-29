# Decision 0006: Minimum Vault Withdrawal Delay

## Status

Accepted.

## Context

`VaultHook.setVaultPolicy` rejected `policy.period == 0` but allowed any
nonzero `policy.delay`, including one second. A vault's entire purpose is the
withdrawal delay: time for the user to notice and cancel or freeze before a
withdrawal executes. A near-zero delay defeats that protection for the
covered asset.

`setVaultPolicy` is already timelock-gated via `notifyConfigChange` (requires
`_executingScheduled`), so a compromised key cannot instantly weaken a vault's
delay — this is a defense against a user misconfiguring their own vault by
mistake, not a privilege-escalation fix.

## Decision

Add `MIN_VAULT_DELAY` (1 hour) and enforce it in `setVaultPolicy`, mirroring
the existing minimum-delay pattern already used for `scheduleCall`
(`MIN_HIGH_RISK_DELAY`/`MIN_CONFIG_DELAY`) and `scheduleMigration`
(`MIN_CONFIG_DELAY`).

## Consequences

Positive:

- Removes a foot-gun where a user could configure a vault policy that looks
  protective but provides effectively no delay.

Risks:

- None identified; the floor is far below any policy a legitimate user would
  configure for genuine long-term storage protection.

Required controls:

- Test coverage proving a delay below the minimum is rejected and the minimum
  itself is accepted (`test/VaultHook.t.sol:testSetVaultPolicyRejectsDelayBelowMinimum`).

## Rejected Alternatives

- No minimum, document the risk instead: rejected because a silent
  misconfiguration is harder to catch than an enforced floor, and the floor
  costs nothing for legitimate use.
