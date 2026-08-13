# Recovery cancellation requires guardian support

Status: accepted
Date: 2026-08-13

Supersedes the owner-only cancellation assumption in decision 0016; its freeze
duration and frozen-cancellation configuration-ratchet decisions remain active.

## Problem

The current account authority could cancel a pending guardian recovery without
another signer. If the validator being replaced was compromised, the attacker
inherited that cancellation authority and could repeatedly reset recovery. The
frozen-cancellation configuration ratchet retired pre-scheduled attacks and
re-armed freezes, but it did not prevent recovery denial of service.

The cancellation path must still protect an uncompromised owner from a
malicious or mistaken guardian recovery. Removing owner participation entirely
would transfer too much authority to the guardian threshold.

## Evidence

`RecoveryManager.cancelRecovery` required only `msg.sender == account`.
`testAccountCannotCancelRecoveryWithoutGuardianApproval` reproduced the issue:
the current validator cleared a pending recovery with no guardian approval.

Argent's published cancellation model requires a majority across the owner and
guardians, while guardian recovery itself uses a guardian threshold. Safe and
Candide-style owner-only cancellation retain the compromised-owner denial of
service under Loom's threat model.

## Options

- Keep owner-only cancellation and rely on freeze/configuration ratcheting.
  Rejected because the compromised validator retains an unbounded recovery
  denial-of-service capability.
- Remove the owner cancellation path. Rejected because a malicious guardian
  threshold would gain an uncontested delayed takeover path.
- Add a distinct cold veto credential. Deferred because it introduces another
  credential lifecycle and recovery authority surface.
- Require the current account plus guardian support, while retaining full
  guardian-threshold cancellation. Chosen as the smallest independently
  executable change that removes the compromised-validator unilateral veto.

## Decision

Owner-assisted cancellation requires a signature from the current account
authority and `max(1, guardianThreshold - 1)` distinct valid guardian approvals.
The approvals sign the existing EIP-712 cancellation digest, which binds the
account, recovery identifier, configuration version, recovery nonce, chain, and
recovery manager.

Guardian-only cancellation remains unchanged and requires the full configured
guardian threshold. No Loom service, administrator, registry, or privileged
publisher is introduced.

The legacy `cancelRecovery(address)` selector remains present but fails closed
with `UnauthorizedCancellation`. New clients use
`cancelRecoveryWithAccountAndGuardians(address, approvals)`. This preserves
wire discovery while preventing an old client from silently retaining the
removed unilateral authority.

Cancellation while frozen remains an exact frozen-safe action. A successful
frozen cancellation still advances `configVersion`, invalidates stale scheduled
authority, and re-arms guardian freeze leaves.

Acceptance requires that owner-only cancellation fail without changing pending
recovery state; owner plus the reduced guardian quorum succeed; the full
guardian threshold can cancel without the owner; malformed, duplicate, stale,
or invalid approvals fail closed; and the frozen cancellation ratchet remains
effective.

## Residual risks

Recovery liveness now depends on at least one available guardian even when the
current owner is legitimate. This is deliberate: a single current validator
cannot be distinguished from an attacker controlling it.

A compromised guardian quorum can still propose recovery and can also cancel
it. Threshold selection and genuine guardian independence remain client-side
ceremony requirements. A threshold-one configuration provides no reduced
owner-assisted quorum: its one guardian is still required.

Existing deployed immutable accounts retain their original cancellation ABI
and authority. The new rule applies only to accounts deployed with the updated
implementation and matching deployment profile; migration and user messaging
require a separate rollout change.
