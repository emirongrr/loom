# Passkey discovery and sponsored onboarding security review

Date: 2026-08-29

Reviewed range: `cf09f60cdce2009604acad24ca28e30f7cda699b` to the
working-tree implementation prepared for release.

## Scope

- account-handle registry and factory binding
- passkey account discovery and live-validator assertion checks
- recovery-passkey post-registration verification
- sponsored first-UserOperation paymaster and reference sponsor policy
- private-first activation transport and public fallback semantics
- Sepolia deployment script and canonical deployment evidence tooling

The desktop diff scanner could not start because it rejected the repository's
Unicode Windows path. The review therefore used the documented manual fallback:
independent threat-model, contract, sponsor/transport, and deployment-evidence
passes, followed by full repository tests. This document does not claim that the
desktop scanner completed.

## Findings resolved before release

1. The shared `LoomAccount` implementation was initialized with deployer
   authority. It is now initialized with `ImplementationLockValidator`, which
   never accepts ERC-4337 or ERC-1271 authority. A test also proves that the
   implementation cannot be reinitialized.
2. The reference sponsor exposed a shared bearer-principal quota and an
   in-memory ledger that would be unsafe as a public service. The reference
   server is now loopback-only and refuses external binding. Production
   deployment requires an authenticated gateway with stable principals and a
   durable, transactional shared quota and idempotency ledger.
3. Sponsor authorization incorrectly required the account signature before the
   paymaster data could be attached. An empty signature is now accepted only at
   the authorization stage; final activation still requires the account
   signature.
4. A failed post-submission code check could incorrectly permit public fallback
   after ambiguous private delivery. All post-send verification failures are
   now delivery-unknown and never fall back to a public bundler.
5. Immutable-runtime evidence accepted incomplete or overlapping immutable
   references. Materialization now rejects missing, out-of-range, and
   overlapping slots.

## Security conclusions

- Registry and locator data are discovery hints, never account authority.
- An account is active for a passkey only after a fresh assertion verifies
  against a currently installed validator key.
- Recovery-passkey registration is followed by a bound assertion before any
  validator publication or guardian request.
- Sponsored onboarding is restricted on chain to nonce-zero account creation
  through the immutable factory, with empty account call data, an expiring
  signed authorization, and a maximum-cost policy.
- Public activation fallback is allowed only after positive proof that the
  private path did not accept the operation. Ambiguous delivery fails closed.

No unresolved reportable vulnerability was found in the reviewed change after
the fixes above. The deliberate residual risks are handle-squatting discovery
denial when an operator chooses public activation, and operational sponsor abuse
if an integrator ignores the production gateway and durable-ledger requirements.

## Verification

- Foundry: 461 passed, 0 failed, 15 skipped
- SDK: 125 passed
- web domain: 516 passed
- web components: 78 passed
- deployment package: 28 passed
- ABI, storage-layout, protocol-surface, documentation, evidence, and diff
  integrity checks passed
