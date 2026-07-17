# Certora Scope

This scope keeps Certora work reviewable before any CVL rule is enabled in CI.

## Initial Contracts

- `src/LoomAccount.sol`
- `src/recovery/RecoveryManager.sol`
- `src/hooks/VaultHook.sol`
- `src/LoomAccountProxy.sol`
- `src/LoomAccountFactory.sol`
- `src/AppAccountRegistry.sol`

## First Rule Group

1. Validator count cannot become zero after any successful account transition.
2. Frozen accounts cannot perform ordinary execution.
3. Guardians cannot perform ordinary execution or validator-only actions.
4. Validators cannot perform guardian/recovery-only actions.
5. Recovery cannot execute before delay, after cancellation, or after expiry.
6. Recovery replacement cannot leave stale validators installed.
7. Migration execution must match scheduled destination, config, call hash, and
   execution window.
8. Factory and registry cannot gain post-deployment account authority.
9. Immutable proxy implementation cannot change.
10. Initialized accounts cannot be initialized again.
11. Delegated initialization cannot be called by arbitrary external actors.

## Required Modeling Decisions

- External validators are summarized by explicit installed/not-installed and
  valid/invalid authorization outcomes.
- External hooks are summarized by explicit pass/revert behavior.
- ERC-20 calls are summarized separately from Loom authority rules.
- Time is adversarial but monotonic.
- EntryPoint behavior is modeled only where required for account authority.

## CI Policy

The `certora` workflow validates readiness on pull requests and exposes a
manual prover job for environments with `CERTORA_KEY`. The prover result must
not be cited as release evidence until:

- Certora CLI version and invocation are pinned;
- rule files exist and have local runtime evidence;
- secrets and license requirements are documented;
- summaries for external modules are reviewed;
- failures are deterministic on a clean checkout.

Manual prover jobs retain target-specific, commit-bound evidence for 30 days.
Partial artifacts aid diagnosis, but only a successful job with a completed
prover log may be cited as runtime evidence. Missing credentials fail closed.
