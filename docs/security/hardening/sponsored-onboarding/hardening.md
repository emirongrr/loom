# Security Hardening Review: Sponsored Onboarding And Private Activation

## Evidence Basis

The review covers sponsor authorization, ERC-4337 funding, private submission, fallback semantics, deployment selection, and lifecycle evidence. The evidence inventory is in [context.md](context.md).

## Constraints

Onboarding remains one guided product flow, but WebAuthn registration cannot sign the activation operation: the new passkey must perform a second assertion. Sponsorship is optional infrastructure, locator data is never authority, and an ambiguous private-delivery error must never cause automatic public resubmission.

## Opportunity Portfolio

| Option | Security result | Operational cost | Decision |
| --- | --- | --- | --- |
| Direct prospective-account prefund | Stranded deposits and repeat-spend ambiguity | Low | Reject |
| Contract wrapper around `depositTo + handleOps` | Incompatible with v0.9 direct-EOA bundler rule | Medium | Reject |
| Signed onboarding paymaster + private bundler RPC | Atomic gas payment, bounded authorization, no account authority | Medium | Selected |

## Recommendation Summary

Use the signed `OnboardingPaymaster`. Reserve budget when an authorization is issued because the signed operation can later be submitted without returning to the sponsor service. Submit the final passkey-signed operation through a separately configured private transaction endpoint. Keep public fallback disabled by default and allow it only after an explicit non-acceptance response.

## Residual Risks

- The reference in-memory ledger is single-process; production operators need an atomic durable quota and idempotency store.
- A private RPC claim must be independently qualified; a private URL alone does not prove exclusion from the public mempool.
- Paymaster owner can withdraw sponsor funds but cannot control user accounts.
- An issued authorization consumes reserved budget even when the user abandons onboarding; expiry-based reclamation needs a durable ledger design.
