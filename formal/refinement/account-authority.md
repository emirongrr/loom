# Account Authority Refinement Map

This file maps Loom's abstract authority properties to executable evidence.
It is not a proof by itself. It is the review checklist that prevents the Lean
model, Halmos properties, and Solidity implementation from drifting apart.

## Scope

Target contracts:

- `src/account/LoomAccount.sol`
- `src/recovery/RecoveryManager.sol`
- `src/modules/VaultHook.sol`
- `src/modules/KeystoreSyncRecoveryModule.sol`
- validator modules under `src/validators/`

Out of scope:

- external token correctness;
- bundler, RPC, relayer, and paymaster liveness;
- UI clear-signing correctness;
- privacy-protocol soundness;
- compiler, chain, and precompile correctness.

## Property Map

| Property | Abstract model | Solidity boundary | Executable evidence |
|---|---|---|---|
| Initialization can happen at most once | Planned initialization theorem | `initialize`, `initializeDelegatedAccount`, `_initialize` | `check_InitializedAccountCannotBeReinitialized`, `check_DelegatedInitializerRejectsExternalCaller`, Certora initialization rules |
| Immutable proxy cannot become upgrade authority | Platform actor theorem plus proxy-specific planned theorem | `LoomAccountProxy.implementation`, fallback delegate path, absence of upgrade/admin mutators | `check_NoMutableUpgradeSelectorsThroughProxy`, proxy unit tests, Certora initialization rules |
| Proxy initialization writes account state to proxy storage | Planned proxy refinement theorem | proxy constructor `delegatecall(initData)`, account storage layout | `check_ImmutableProxyInitializesProxyStorage`, proxy unit tests |
| Validator count never becomes zero | `successful_step_preserves_validator_nonzero` | `_uninstallModule`, recovery replacement, validator-set validation | `check_CannotRemoveLastValidator`, `LoomAccountInvariantTest`, recovery unit tests |
| Frozen accounts cannot perform ordinary execution | `frozen_blocks_ordinary_execution` | `_executeAuthorized`, `executeDirect`, `executeMigration` | `check_FrozenAccountCannotExecute`, `check_FrozenAccountCannotDirectExecute`, migration tests |
| Frozen accounts may cancel recovery through the emergency carveout | `frozen_guardian_cancel_recovery_allowed` | `_isFrozenSafe`, `RecoveryManager.cancelRecovery` | `check_FrozenAccountOnlyAllowsRecoveryCancel` |
| Recovery cannot execute before delay | Pending model extension | `RecoveryManager.pendingRecoveries`, `executeRecovery` | `check_RecoveryDelayIsEnforced`, recovery unit tests |
| Recovery replaces the old validator set | `recovery_requires_nonzero_replacement` plus planned complete-set theorem | `recoverConfiguration`, `recoverConfigurationSet`, `_validateCompleteValidatorSet` | `check_RecoveryReplacesValidatorSet`, recovery unit tests |
| Platform actors have no ordinary account authority | `platform_actors_cannot_ordinary_execute_when_not_frozen` | no owner/admin/deployer path, factory/registry non-authority | proxy/factory tests, `check_GuardianCannotPerformValidatorAction`, direct privileged-call tests |
| Migration execution is bound to scheduled call hash | Pending model extension | `scheduleMigration`, `executeMigration`, `pendingMigration.callsHash` | `check_MigrationHashBinding` |
| Failed batch execution is atomic | Pending model extension | `_executeAuthorized` batch loop, EVM revert behavior | `check_BatchExecutionAtomicity`, `check_DirectBatchExecutionAtomicity`, migration atomicity tests |

## Historical Wallet Bug-Class Mapping

| Bug class | Loom rule | Current evidence | Residual work |
|---|---|---|---|
| Uninitialized account or implementation takeover | Account initialization is one-shot and delegated initialization is self-only. | `check_InitializedAccountCannotBeReinitialized`, `check_DelegatedInitializerRejectsExternalCaller`, `LoomAccountInitialization.spec` | Add proxy-factory differential tests to the audit manifest. |
| Mutable upgrade/admin takeover | Deployment efficiency must not introduce upgrade authority. | `check_NoMutableUpgradeSelectorsThroughProxy`, immutable implementation pointer unit tests | Add bytecode-level selector scan to deployment manifest tooling. |
| Arbitrary module/delegatecall backdoor | Modules cannot execute unsupported executor paths or bypass self/scheduled gates. | `check_PrivilegedAccountFunctionsRejectExternalCall`, `executeFromExecutor` reverts, limited execution mode tests | Add module-adapter conformance tests for every production module. |
| Signature replay | Signatures must bind account, chain, config version, nonce, validator, and call hash where applicable. | direct execution digest tests, migration hash-binding tests, recovery/migration digest docs | Add explicit cross-chain fork tests for digest separation. |
| Partial batch state | Failed atomic execution must revert earlier effects and nonce changes. | `check_BatchExecutionAtomicity`, `check_DirectBatchExecutionAtomicity`, migration atomicity tests | Add token-portfolio rehearsal with non-standard ERC-20s. |

## Refinement Requirements Before Audit Freeze

- Every model transition must name the Solidity function or group of functions
  that implements it.
- Every model precondition must map to a Solidity guard or documented
  environment assumption.
- Every model state field must map to a storage field, derived predicate, or
  explicit abstraction.
- Every theorem cited externally must have at least one executable Solidity
  property or invariant covering the same intent.
- Any mismatch must either update the model, update the implementation, or be
  recorded as a deliberate abstraction with residual risk.
