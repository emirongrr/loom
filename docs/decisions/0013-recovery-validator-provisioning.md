# ADR 0013: Recovery validator provisioning

## Status

Proposed for a separate contract change. The web example must fail closed until a compatible uninstalled validator is supplied by a verified deployment profile.

## Context

`RecoveryManager` replaces the complete validator set and rejects an already-installed `newValidator`. The baseline web example works around this by calling an unauthenticated backend that deploys a full `P256Validator` for each recovery. That makes a Loom-hosted key and endpoint appear necessary even though the transaction itself is permissionless.

## Options considered

### A. Recoverable validator interface

`recoverKey(account, initData)` could rotate account-specific material in place. It avoids deployment gas, but adds a new privileged caller path to every validator, complicates reentrancy and cleanup, couples validators to `RecoveryManager`, and changes formal/config-version assumptions. Code-hash pinning cannot by itself prove correct caller scoping. Rejected for this task.

### B. Deterministic validator instances

A permissionless immutable factory can deploy a minimal instance or clone at a counterfactual address derived from account, recovery nonce, implementation code hash, and initialization commitment. Any party may deploy it; no deployer key has authority. The SDK can calculate and verify the address and runtime code hash before guardians sign. This has deployment gas and requires a new audited factory, CREATE2 race analysis, immutable implementation binding, fallback-verifier binding, manifest support, and formal properties. Preferred future architecture.

### C. Predeployed validator family

Accounts could rotate among identical shared validators. Two validators permit repeated single-validator recovery by alternating after the prior validator is removed, but multi-validator accounts can install the whole family. Guaranteeing an unused member requires more than the account's maximum validator count, inflating deployment/manifests and hiding rather than eliminating provisioning. Rejected.

### D. MultiP256-based recovery

`MultiP256Validator` supports multiple credentials but its add/remove methods are scheduled self-configuration. Treating those methods as recovery would either preserve a compromised threshold/credential or add the same new recovery caller boundary as option A. It also does not represent arbitrary complete multi-validator replacement. Rejected as a general recovery solution.

## Decision

Do not change production contracts in the wallet refactor. Remove the generic deploy endpoint from the normal path. Accept only an injected, manifest-verified, uninstalled compatible validator and return a typed `UNSUPPORTED_RECOVERED_VALIDATOR_PATH` error when none exists. Preserve direct/manual submission and devnet evidence.

Design option B as a later, separate authority-changing change. Its acceptance evidence must include factory unit/integration/invariant/formal tests, counterfactual differential fixtures, deployment-race tests, code-hash and fallback-verifier binding, repeated and multi-validator recovery, gas snapshots, canonical manifest updates, migration notes, and an independent security review.

## Consequences

The example is honest about current deployment capability and has no mandatory hosted deployer. Existing deployments need a compatible provisioned validator or future factory before browser recovery can complete. The protocol's current recovery invariants remain unchanged.

