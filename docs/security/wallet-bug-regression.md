# Wallet Bug-Class Regression Matrix

Loom tracks historical wallet failures as bug classes. The goal is not to copy
another wallet's design, but to make sure recurring account-abstraction and
multisig failure modes have explicit regression evidence.

## Regression Classes

| Bug class | Loom design rule | Evidence today | Audit-freeze gap |
|---|---|---|---|
| Uninitialized implementation or account takeover | Initialization is one-shot; delegated initialization is self-only. | `LoomAccountInitializationFormal`, constructor/initializer unit tests, Certora initialization rules. | Add bytecode manifest evidence for implementation initialization state. |
| Mutable upgrade/admin takeover | Proxy is immutable and deployment-cost only; migration is explicit and user controlled. | Proxy tests, `check_NoMutableUpgradeSelectorsThroughProxy`, deployment docs. | Add deployed-bytecode selector scan for upgrade/admin/beacon functions. |
| Arbitrary delegatecall or module backdoor | Account exposes no user-controlled arbitrary delegatecall; executor adapters are deliberately unsupported unless explicitly added. | Unsupported execution mode tests, `executeFromExecutor` rejection, module lifecycle tests. | Add conformance tests for every production ERC-7579 adapter. |
| Signature replay | Signed authority must bind nonce, account, chain, config version, validator, and committed call hash. | Direct execution nonce rollback tests, migration hash-binding tests, EIP-712 domain usage. | Add cross-chain fork tests and ERC-1271 replay-negative fixtures. |
| Session nonce-key collision | Distinct session permissions must not share one ERC-4337 nonce key. | Exact-call and granular validators reject permission IDs that collide after 192-bit nonce-key truncation. | Add SDK helpers that derive and display the canonical nonce key before signing. |
| Guardian duplicate or threshold abuse | Guardian approvals must not count duplicate leaves and must rotate roots through delayed recovery/config paths. | Recovery unit tests and symbolic delay/replacement checks. | Add full guardian ceremony fixture tests and encrypted backup checks. |
| Recovery bypass | Recovery must be visible, delayed, cancellable, and complete-set replacing. | `check_RecoveryDelayIsEnforced`, recovery replacement properties, freeze carveout tests. | Add expiry/cancellation symbolic targets and live ceremony rehearsal. |
| Composite lifecycle bypass | Freeze, migration, scheduled operations, and recovery are overlapping state dimensions; one pending state must not weaken another. | Composite freeze + pending recovery + pending migration regression; lifecycle docs model the state as orthogonal overlays. | Add model-based state-machine campaigns for every overlapping pending-state pair. |
| Partial batch state after revert | Atomic execution must leave no partial spending effects. | `check_BatchExecutionAtomicity`, direct batch rollback, migration atomicity tests. | Add ERC-20/non-standard-token rehearsal. |
| Factory or registry authority creep | Factory/registry may deploy or count accounts, but cannot execute, upgrade, freeze, recover, or veto them. | Proxy/factory/registry tests and architecture docs. | Add Certora/Kontrol rules for factory and registry non-authority. |
| EIP-7702 persistent delegation phishing | Delegated setup must be template-bound, visible, and revocable by migration/recovery paths. | Delegated initializer self-only property and 7702 docs. | Client-side clear-signing/template verification and testnet phishing rehearsals. |
| Paymaster overspend or censorship | Paymasters remain optional and policy-limited; core account does not depend on a company paymaster. | Paymaster policy docs and SDK boundaries. | Live sponsored/native fallback evidence across independent bundlers. |

## Review Rule

Adding an account authority feature requires updating this matrix when it
touches initialization, upgrades, modules, signatures, recovery, batching,
factory/registry behavior, delegation, or paymaster policy.
