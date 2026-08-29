# Implementation Plan: Sponsored Onboarding

1. Deploy and test `OnboardingPaymaster` with a separate authorizer and bounded maximum cost.
2. Add deployment-profile selection and pin paymaster runtime bytecode.
3. Add authorization-before-passkey-signing and private-first submission adapters.
4. Enforce authenticated principal quota, global budget, idempotency, factory/call/gas bounds, and five-minute authorization expiry.
5. Require a distinct private submission RPC and independently verify live paymaster immutables at service startup.
6. Validate local contract, SDK, web, deployment, and evidence gates.
7. Freeze and merge a clean release commit.
8. Deploy Sepolia, fund the paymaster deposit, verify sources, and qualify the private provider.
9. Perform the complete second-device and guardian recovery rehearsal.
10. Build canonical evidence and collect three distinct attestations.

Rollback is application-level: publish a counterfactual profile or disable the sponsor service. Deployed accounts and validators remain unaffected.
