# Account Authority Refinement Map

This file maps Loom's abstract authority model to the complete current
`check_` property inventory and the Solidity boundaries those properties
exercise. It is a review and drift-control artifact, not a refinement proof by
itself.

## Scope

Target contracts:

- `src/LoomAccount.sol`
- `src/LoomAccountProxy.sol`
- `src/LoomAccountFactory.sol`
- `src/AppAccountRegistry.sol`
- `src/recovery/RecoveryManager.sol`
- `src/recovery/KeystoreSyncRecoveryModule.sol`
- `src/keystore/LoomKeystore.sol`
- `src/hooks/VaultHook.sol`
- validator modules under `src/validators/`

Out of scope:

- external token correctness;
- bundler, RPC, relayer, and paymaster liveness;
- UI clear-signing correctness;
- privacy-protocol soundness;
- compiler, chain, and precompile correctness.

The executable inventory below is complete for committed `check_` functions in
`test/formal/`. The semantic refinement is intentionally partial: rows marked
"not modeled" are concrete symbolic properties without a corresponding Lean
state field or transition. Their presence is an explicit gap, not evidence
that the abstract model proves them.

## Executable Refinement Matrix

| Executable property | Security intent | Abstract relation | Solidity boundary | Explicit gap or assumption |
|---|---|---|---|---|
| `check_InitializedAccountCannotBeReinitialized` | Initialization is one-shot. | `initialized_state_rejects_reinitialization` | `initialize`, `_initialize` | Lean abstracts caller and initialization payload. |
| `check_DelegatedInitializerRejectsExternalCaller` | Delegated initialization is self-only. | Not modeled. | `initializeDelegatedAccount` | Lean has no caller/self-call predicate. |
| `check_ImmutableProxyInitializesProxyStorage` | Constructor delegation initializes proxy storage only. | Not modeled. | proxy constructor delegatecall and account storage | Lean has no proxy/implementation storage separation. |
| `check_NoMutableUpgradeSelectorsThroughProxy` | The immutable proxy exposes no upgrade transition. | `immutable_proxy_has_no_upgrade_transition` | `LoomAccountProxy.implementation`, fallback path | The theorem abstracts bytecode selectors and delegatecall semantics. |
| `check_InvalidDirectExecutionDoesNotConsumeNonce` | Rejected direct execution preserves its nonce. | Not modeled. | `executeDirect`, validator nonce storage | Lean has no nonce or signature state. |
| `check_BatchExecutionAtomicity` | A reverting ordinary batch leaves no partial effect. | Not modeled. | `_executeAuthorized`, batch execution loop | Lean has no external-call state or EVM revert semantics. |
| `check_FrozenAccountCannotExecute` | Freeze blocks ordinary EntryPoint execution. | `frozen_blocks_ordinary_execution` | `execute`, `_executeAuthorized` | Lean collapses EntryPoint and validator authorization into an actor. |
| `check_FrozenAccountCannotDirectExecute` | Freeze blocks ordinary direct execution. | `frozen_blocks_ordinary_execution` | `executeDirect`, `_executeAuthorized` | Direct nonce/signature behavior is not modeled. |
| `check_DirectBatchExecutionAtomicity` | A reverting direct batch preserves effects and nonce. | Not modeled. | `executeDirect`, batch loop, direct nonce | Lean has no nonce, external calls, or revert rollback. |
| `check_ExternalCannotSetGuardianConfig` | External callers cannot change guardian authority. | Not modeled. | `setGuardianConfig`, self-call guard | Lean does not model guardian configuration fields or self-call routing. |
| `check_GuardianlessBootstrapHasNoGuardianAuthority` | An empty guardian bootstrap grants no guardian power. | Not modeled. | constructor guardian fields, `freeze`, `setGuardianConfig` | Lean has no guardian root or threshold. |
| `check_ExternalCannotRecoverConfiguration` | External callers cannot invoke account-internal recovery. | Not modeled. | `recoverConfiguration`, `recoverConfigurationSet` | Lean models the recovery transition but not its authorized caller. |
| `check_UnsupportedExecutionModeNeverExecutes` | Unsupported ERC-7579 modes cannot call targets. | Not modeled. | `execute`, execution-mode decoder | Lean has no execution-mode domain. |
| `check_CannotRemoveLastValidator` | Every successful transition retains a validator. | `successful_step_preserves_validator_nonzero` | `_uninstallModule`, validator-set validation | Concrete coverage is selected paths, not every future module transition. |
| `check_ConfigUpdateInvalidatesStaleSchedule` | Authority changes invalidate stale scheduled calls. | `config_version_never_decreases_on_success` | `configVersion`, `configHash`, scheduled calls | Lean proves monotonicity, not schedule/version binding. |
| `check_GuardianCannotPerformValidatorAction` | Guardian authority cannot become spending authority. | Not modeled. | `execute`, caller/EntryPoint guards | `ordinaryActorAllowed` rejects guardians but does not refine guardian proofs. |
| `check_ValidatorCannotPerformGuardianRecoveryAction` | Validator authority cannot mutate guardian/recovery state directly. | Not modeled. | `setGuardianConfig`, recovery entry points | Lean has no action-specific actor permissions. |
| `check_PrivilegedAccountFunctionsRejectExternalCall` | Privileged lifecycle functions remain self-only. | `platform_actors_cannot_ordinary_execute_when_not_frozen` is related but insufficient. | schedule/cancel/install/uninstall/unfreeze self-call guards | The theorem covers ordinary execution, not privileged selector routing. |
| `check_MigrationDelayIsEnforced` | Migration cannot execute before its delay. | Not modeled. | `scheduleMigration`, `executeMigration`, `readyAt` | Lean has pending state but no time or readiness transition. |
| `check_MigrationHashBinding` | Migration executes only its committed call batch. | Not modeled. | `pendingMigration.callsHash`, `executeMigration` | Lean has no destination, config, or call hashes. |
| `check_MigrationBatchAtomicity` | A failed migration batch preserves pending state and effects. | Not modeled. | `executeMigration`, batch loop, pending migration | Lean has no external calls or rollback semantics. |
| `check_RecoveryDelayIsEnforced` | Recovery cannot execute before readiness. | Not modeled. | `pendingRecoveries`, `executeRecovery`, `readyAt` | Lean has `recoveryReady` but no transition or time relation that makes it true. |
| `check_RecoveryReplacesValidatorSet` | Recovery installs a non-empty committed replacement set. | `recovery_requires_nonzero_replacement` | `recoverConfigurationSet`, complete-set validation | The theorem proves non-zero count, not exact old/new set replacement. |
| `check_FrozenAccountOnlyAllowsRecoveryCancel` | Frozen guardian cancellation removes pending recovery without spending. | `frozen_guardian_cancel_recovery_allowed` | `_isFrozenSafe`, `cancelRecovery` | Guardian proof uniqueness and cancellation digest are abstracted. |
| `check_KeystoreUpdateRequiresController` | Only the identity controller can update keystore configuration. | Not modeled. | `LoomKeystore.updateConfig` | Lean has no identity, controller, or root/version tuple. |
| `check_SyncDelayIsEnforced` | Keystore sync cannot replace validators before delay. | Not modeled. | `proposeSync`, `executeSync`, `pendingSyncs.readyAt` | Keystore proof, time, and validator-root binding are absent. |
| `check_GuardianCancellationGrantsNoValidatorAuthority` | Cancelling sync grants no validator authority. | Not modeled. | `cancelSyncWithGuardians`, pending sync and validator set | Lean has no keystore sync transition or guardian proof model. |
| `check_VaultWithdrawalDelayIsEnforced` | Protected assets cannot leave before vault delay. | Not modeled. | vault policy hook, `scheduleVaultWithdrawal`, account execution | Lean has no asset, hook, policy, or time state. |
| `check_VaultGuardianCancellationGrantsNoSpendingAuthority` | Cancelling a withdrawal grants no spending authority. | Not modeled. | `cancelVaultWithdrawalWithGuardians`, pending withdrawal | Lean has no vault withdrawal or token-balance abstraction. |

## Abstract State Mapping

| Lean state | Concrete representation | Refinement status |
|---|---|---|
| `validatorCount` | `LoomAccount.validatorCount()` and installed validator modules | Count mapped; validator identities and init data are abstracted. |
| `configVersion` | `LoomAccount.configVersion()` | Directly mapped; `configHash` and stale-operation bindings remain concrete-only. |
| `frozen` | `block.timestamp < LoomAccount.frozenUntil()` | Derived predicate mapped; the Lean Boolean omits the clock and expiry transition. |
| `recoveryPending` | `RecoveryManager.pendingRecoveries(account).readyAt != 0` | Predicate mapped; proposal digest, expiry, and validator set are abstracted. |
| `recoveryReady` | Pending recovery exists and `block.timestamp >= readyAt` | Predicate identified, but Lean has no clock transition. |
| `migrationPending` | `LoomAccount.pendingMigration().readyAt != 0` | Predicate mapped; destination, EntryPoint, code hash, config, and calls hash are abstracted. |
| `initialized` | `LoomAccount.configVersion() != 0` plus initialized module/configuration state | Derived predicate mapped; storage-slot and proxy context are concrete-only. |

## Abstract Transition Mapping

| Lean transition | Concrete entry points | Preconditions represented in Lean | Concrete-only preconditions |
|---|---|---|---|
| `ordinaryExecute` | `execute`, `executeDirect` | not frozen; abstract actor allowed | EntryPoint, validator signature, nonce, hooks, execution mode, call success |
| `freezeByGuardian` | `freeze` | none | guardian root, threshold, unique proofs, config binding |
| `scheduleRecovery` | `RecoveryManager.proposeRecovery` | none | module installation, proposal hash, validator ordering, delay/expiry |
| `cancelRecoveryByGuardian` | `RecoveryManager.cancelRecovery` | frozen and pending | proof verification, exact cancellation digest, operation identity |
| `executeRecovery` | `RecoveryManager.executeRecovery` then account recovery functions | pending, ready, non-zero replacement | time, expiry, exact set replacement, proof/digest and config binding |
| `configChange` | successful scheduled self-calls that mutate modules or guardian configuration | version increments abstractly | scheduling delay, operation hash, exact changed state, stale invalidation |
| `scheduleMigration` | `scheduleMigration` | none | destination code hash, EntryPoint, config and call hash, delay/expiry |
| `executeMigration` | `executeMigration` | pending and not frozen | time window, exact bindings, hook mediation, atomic external calls |
| `initialize` | `initialize`, `initializeDelegatedAccount` | not already initialized | proxy context, self-call restriction, module initialization payload |
| `upgradeImplementation` | no supported entry point | always rejected | bytecode-level absence of upgrade/admin selectors |

## Lean Theorem Coverage

Every current theorem has at least one concrete review anchor:

- `frozen_blocks_ordinary_execution`: frozen EntryPoint and direct-execution properties;
- `initialized_state_rejects_reinitialization`: one-shot initialization property;
- `immutable_proxy_has_no_upgrade_transition`: immutable proxy selector property;
- `frozen_guardian_cancel_recovery_allowed`: frozen recovery-cancel property;
- `recovery_requires_nonzero_replacement`: recovery replacement and last-validator properties;
- `platform_actors_cannot_ordinary_execute_when_not_frozen`: factory/proxy non-authority tests and privileged-call property;
- `successful_step_preserves_validator_nonzero`: last-validator property and stateful invariants;
- `config_version_never_decreases_on_success`: stale-schedule property and configuration invariants.

These anchors show intent alignment. They do not establish a machine-checked
simulation relation between Lean transitions and EVM executions.

## Historical Wallet Bug-Class Mapping

| Bug class | Loom rule | Current evidence | Residual work |
|---|---|---|---|
| Uninitialized account or implementation takeover | Account initialization is one-shot and delegated initialization is self-only. | Initialization properties and `LoomAccountInitialization.spec` | Add proxy-factory differential evidence to the deployment manifest. |
| Mutable upgrade/admin takeover | Deployment efficiency must not introduce upgrade authority. | Immutable proxy symbolic property, selector checks, and unit tests | Add bytecode-level selector evidence to deployment qualification. |
| Arbitrary module/delegatecall backdoor | Modules cannot execute unsupported executor paths or bypass self/scheduled gates. | Privileged-call and unsupported-mode properties plus limited-mode tests | Add adapter conformance tests for every production module. |
| Signature replay | Signatures bind account, chain, config version, nonce, validator, and call hash where applicable. | Direct-execution nonce property, digest tests, and migration binding property | Add explicit cross-chain fork tests for digest separation. |
| Partial batch state | Failed atomic execution reverts earlier effects and nonce changes. | Ordinary, direct, and migration atomicity properties | Add token-portfolio rehearsal with non-standard ERC-20s. |

## Refinement Requirements Before Audit Freeze

- Every model transition must name the Solidity function or group of functions
  that implements it.
- Every model precondition must map to a Solidity guard or documented
  environment assumption.
- Every model state field must map to a storage field, derived predicate, or
  explicit abstraction.
- Every theorem cited externally must have at least one executable Solidity
  property or invariant covering the same intent.
- Every committed `check_` property must appear exactly once in the executable
  refinement matrix.
- Any mismatch must either update the model, update the implementation, or be
  recorded as a deliberate abstraction with residual risk.
