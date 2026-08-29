# Proposal: Signed Onboarding Paymaster With Private Submission

## Selected Design

1. Deployment operator chooses `counterfactual` or `sponsored` in the wallet profile.
2. Sponsored deployments pin `OnboardingPaymaster` bytecode, a policy ID/hash, maximum cost, quota, window, and fallback policy.
3. The browser creates the passkey and builds an empty nonce-zero activation.
4. The sponsor service authenticates the application principal, reserves budget, and signs short-lived paymaster data.
5. The browser inserts the paymaster fields, then asks the account passkey to sign the final canonical UserOperation hash.
6. The relay submits `handleOps` through a distinct private transaction RPC.
7. Both ordinary RPCs independently confirm the EntryPoint event and deployed account.

## Required Invariants

- Sponsorship accepts only the pinned chain, EntryPoint, factory, paymaster, policy hash, nonce zero, empty account callData, and bounded gas.
- The authorizer key grants gas sponsorship only; it is not installed as an account validator.
- Paymaster signature binds sender, init code, gas words, validity interval, cost limit, and policy hash.
- Budget is reserved before the signature leaves the service.
- Network timeout or unknown relay delivery never triggers public fallback.
- Discovery still resolves a candidate and verifies a fresh assertion against the live validator key.

## Production Requirements

Replace the in-memory reference ledger with a transactional shared store keyed by authenticated principal and authorization hash. Qualify the private provider with a canary transaction and documented non-broadcast semantics. Monitor paymaster deposit, authorization rate, rejection reasons, expiry waste, and private inclusion latency.
