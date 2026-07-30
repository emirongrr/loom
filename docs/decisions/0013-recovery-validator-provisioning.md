# ADR 0013: Recovery validator provisioning

## Status

Accepted. Implemented for new core deployments and available as a standalone,
non-disruptive addition to existing deployments. A wallet must still fail closed
unless the factory and child-validator bytecode are bound by its verified
deployment profile.

## Context

`RecoveryManager` replaces the complete validator set and rejects an already-installed `newValidator`. The baseline web example works around this by calling an unauthenticated backend that deploys a full `P256Validator` for each recovery. That makes a Loom-hosted key and endpoint appear necessary even though the transaction itself is permissionless.

## Options considered

### A. Recoverable validator interface

`recoverKey(account, initData)` could rotate account-specific material in place. It avoids deployment gas, but adds a new privileged caller path to every validator, complicates reentrancy and cleanup, couples validators to `RecoveryManager`, and changes formal/config-version assumptions. Code-hash pinning cannot by itself prove correct caller scoping. Rejected for this task.

### B. Deterministic validator instances (selected)

A permissionless immutable factory can deploy a minimal instance or clone at a counterfactual address derived from account, recovery nonce, implementation code hash, and initialization commitment. Any party may deploy it; no deployer key has authority. The SDK can calculate and verify the address and runtime code hash before guardians sign. This has deployment gas and requires a new audited factory, CREATE2 race analysis, immutable implementation binding, fallback-verifier binding, manifest support, and formal properties. Preferred future architecture.

### C. Predeployed validator family

Accounts could rotate among identical shared validators. Two validators permit repeated single-validator recovery by alternating after the prior validator is removed, but multi-validator accounts can install the whole family. Guaranteeing an unused member requires more than the account's maximum validator count, inflating deployment/manifests and hiding rather than eliminating provisioning. Rejected.

### D. MultiP256-based recovery

`MultiP256Validator` supports multiple credentials but its add/remove methods are scheduled self-configuration. Treating those methods as recovery would either preserve a compromised threshold/credential or add the same new recovery caller boundary as option A. It also does not represent arbitrary complete multi-validator replacement. Rejected as a general recovery solution.

## Decision

Deploy an immutable `P256RecoveryValidatorFactory` as part of every core
deployment. The factory has no owner, administrator, upgrade path, allowlist,
or mutable configuration. Any caller may deploy the validator at the CREATE2
address committed to:

- the factory address and its immutable P-256 fallback-verifier binding;
- the account being recovered;
- that account's current recovery nonce; and
- the hash of the new validator initialization data.

Deployment is idempotent. Front-running only pays for the exact validator the
user already committed to; it cannot alter its address, bytecode, passkey, RP
ID, origin, or policy hook. The factory does not initialize the validator and
receives no account authority. Initialization remains atomic with
`RecoveryManager.executeRecovery`, after the guardian-approved delay.

The canonical deployment manifest pins the factory runtime code hash, child
validator runtime code hash, and fallback verifier. The SDK independently reads
factory code and immutables, derives the expected child address, and checks the
deployed child code before allowing guardians to sign. Policy-hook addresses are
an application-profile allowlist and are validated from `initData`.

Existing deployments add only this factory, using the fallback-verifier value
read from their already-published `P256Validator`. Their account factory,
implementation, validators, accounts, and local wallet records are unchanged.

## Consequences

Recovery no longer needs a Loom-operated validator deployer or hosted endpoint.
It adds one audited deployment primitive and child-deployment gas. CREATE2
address derivation and manifest verification become part of the recovery trust
boundary. Existing recovery delay, guardian threshold, complete validator-set
replacement, and configuration-version invariants remain unchanged.
