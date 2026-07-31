# ADR 0013: Recovery validator provisioning

## Status

Accepted. New recovery intents may use the immutable, permissionless provisioning factory described below. Existing deployments remain bound to their published deployment profile.

## Context

`RecoveryManager` replaces the complete validator set and rejects an already-installed `newValidator`. The baseline web example works around this by calling an unauthenticated backend that deploys a full `P256Validator` for each recovery. That makes a Loom-hosted key and endpoint appear necessary even though the transaction itself is permissionless.

## Options considered

### A. Recoverable validator interface

`recoverKey(account, initData)` could rotate account-specific material in place. It avoids deployment gas, but adds a new privileged caller path to every validator, complicates reentrancy and cleanup, couples validators to `RecoveryManager`, and changes formal/config-version assumptions. Code-hash pinning cannot by itself prove correct caller scoping. Rejected for this task.

### B. Deterministic validator instances with atomic intent reservation

A permissionless immutable factory deploys a recovery-specific instance at a counterfactual address derived from account, recovery nonce, implementation code hash, and initialization commitment. Any party may deploy it; no deployer key has authority. In the same transaction, the factory reserves the child for the exact account and initializer hash. A wrong initializer cannot consume the reservation, while an exact initializer submitted before delayed execution is idempotent and therefore cannot veto recovery. The child has constant runtime bytecode for one factory profile, so the SDK can calculate the address and verify the runtime code hash before guardians sign. This has deployment and storage gas and requires factory, child, CREATE2 race, fallback-verifier, manifest, and lifecycle evidence. Selected.

### C. Predeployed validator family

Accounts could rotate among identical shared validators. Two validators permit repeated single-validator recovery by alternating after the prior validator is removed, but multi-validator accounts can install the whole family. Guaranteeing an unused member requires more than the account's maximum validator count, inflating deployment/manifests and hiding rather than eliminating provisioning. Rejected.

### D. MultiP256-based recovery

`MultiP256Validator` supports multiple credentials but its add/remove methods are scheduled self-configuration. Treating those methods as recovery would either preserve a compromised threshold/credential or add the same new recovery caller boundary as option A. It also does not represent arbitrary complete multi-validator replacement. Rejected as a general recovery solution.

## Decision

Implement option B as a separate contract change. `P256RecoveryValidatorFactory` has no owner, upgrade path, mutable configuration, or account authority. It deploys a `P256RecoveryValidator` deterministically and atomically reserves `(account, initDataHash)` before returning control. The recovery child accepts only the exact committed initializer from the reserved account; an exact repeat succeeds without changing state. Ordinary `P256Validator` deployments are unchanged.

Applications must accept the provisioner only through a canonical, chain-verified deployment profile that binds the factory address, factory runtime code hash, child runtime code hash, and fallback verifier. Existing pending recovery intents are never silently reinterpreted for a new factory profile.

## Consequences

Recovery validator publication is permissionless and does not require a hosted deployer. The reservation closes the CREATE2 initialization race in which compromised current authority could otherwise initialize the child with different key material before the delayed recovery. The compromised authority still exists until recovery executes, so freeze, cancellation, config-version invalidation, and the visible delay remain necessary.

The factory and child add deployment gas and immutable bytecode that must be published and independently verified per deployment profile. Existing deployments need the compatible factory profile before browser recovery can use this path. Factory unit and fuzz tests, adversarial recovery lifecycle tests, generated ABI checks, manifest binding, bytecode/gas evidence, and independent review remain release evidence rather than a production-readiness claim.
