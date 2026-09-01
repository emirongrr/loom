# Implementation Status: Sponsored Onboarding

## Implemented And Verified In Source

1. `OnboardingPaymaster` separates the authorizer from the owner and bounds the
   maximum sponsored cost.
2. Deployment profiles select counterfactual or sponsored onboarding and pin
   the paymaster runtime hash and immutable policy.
3. Paymaster authorization is attached before the passkey signs the final
   UserOperation, and sponsored submission is private-first.
4. The loopback reference service enforces a principal quota, global budget,
   idempotency, factory/call/gas bounds, and five-minute authorization expiry.
5. The service requires a private submission RPC distinct from its public read
   RPC and verifies live paymaster immutables at startup.
6. Contract, SDK, web, deployment-profile, and lifecycle-evidence tests cover
   the source implementation.

## Required Before A Production Release

1. Replace the loopback in-memory ledger with an authenticated gateway and a
   transactional shared quota, reservation, expiry, and idempotency store.
2. Freeze and merge a clean release commit.
3. Deploy to Sepolia, fund the paymaster deposit, verify sources, and qualify
   the selected private provider independently.
4. Perform the complete second-device and guardian recovery rehearsal.
5. Build canonical evidence and collect three distinct attestations.

Rollback is application-level: publish a counterfactual profile or disable the sponsor service. Deployed accounts and validators remain unaffected.
