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
| `check_DelegatedInitializerRejectsExternalCaller` | Delegated initialization is self-only. | `external_delegated_initializer_preserves_state` | `initializeDelegatedAccount` | Lean abstracts the caller predicate to a self-call Boolean; proxy storage and initialization payload remain concrete. |
| `check_ImmutableProxyInitializesProxyStorage` | Constructor delegation initializes proxy storage only. | `proxy_initialization_updates_only_proxy_storage` | proxy constructor delegatecall and account storage | Lean models separate proxy and implementation storage values; EVM delegatecall context, slot layout, and initialization payload decoding remain concrete. |
| `check_NoMutableUpgradeSelectorsThroughProxy` | The immutable proxy exposes no upgrade transition. | `immutable_proxy_has_no_upgrade_transition` | `LoomAccountProxy.implementation`, fallback path | The theorem abstracts bytecode selectors and delegatecall semantics. |
| `check_InvalidDirectExecutionDoesNotConsumeNonce` | Rejected direct execution preserves its nonce. | `rejected_direct_execution_preserves_nonce` | `executeDirect`, validator nonce storage | Lean models one abstract validator nonce; signature digest, validator identity, and nonce map isolation remain concrete. |
| `check_BatchExecutionAtomicity` | A reverting ordinary batch leaves no partial effect. | `failed_batch_preserves_state`, `successful_batch_commits_all_effects` | `_executeAuthorized`, batch execution loop | Lean abstracts external calls to a committed effect counter and does not model EVM revert data. |
| `check_FrozenAccountCannotExecute` | Freeze blocks ordinary EntryPoint execution. | `frozen_blocks_ordinary_execution` | `execute`, `_executeAuthorized` | Lean collapses EntryPoint and validator authorization into an actor. |
| `check_FrozenAccountCannotDirectExecute` | Freeze blocks ordinary direct execution. | `frozen_blocks_ordinary_execution` | `executeDirect`, `_executeAuthorized` | Direct nonce/signature behavior is not modeled. |
| `check_DirectBatchExecutionAtomicity` | A reverting direct batch preserves effects and nonce. | `failed_batch_preserves_state` | `executeDirect`, batch loop, direct nonce | Lean abstracts nonce and external calls; concrete rollback remains covered by the Solidity property. |
| `check_GuardianlessBootstrapHasNoGuardianAuthority` | An empty guardian bootstrap grants no guardian power. | `guardianless_bootstrap_has_no_guardian_authority` | constructor guardian fields, `freeze`, `setGuardianConfig` | Lean abstracts guardian configuration to a Boolean; exact root and threshold validation remain concrete. |
| `check_ExternalCannotSetGuardianConfig` | External callers cannot change guardian authority. | `external_guardian_config_preserves_state` | `setGuardianConfig`, self-call guard | Lean abstracts guardian root and threshold to the configuration-version state; exact guardian fields remain concrete. |
| `check_UnsupportedExecutionModeNeverExecutes` | Unsupported ERC-7579 modes cannot call targets. | `unsupported_execution_mode_preserves_state` | `execute`, execution-mode decoder | Lean abstracts mode support to a Boolean and does not model target calldata decoding. |
| `check_ExternalCannotRecoverConfiguration` | External callers cannot invoke account-internal recovery. | `external_recovery_preserves_authority_state` | `recoverConfiguration`, `recoverConfigurationSet` | Lean abstracts the recovery-module caller predicate; validator replacement payload and proof routing remain concrete. |
| `check_CannotRemoveLastValidator` | Every successful transition retains a validator. | `successful_step_preserves_validator_nonzero` | `_uninstallModule`, validator-set validation | Concrete coverage is selected paths, not every future module transition. |
| `check_ConfigUpdateInvalidatesStaleSchedule` | Authority changes invalidate stale scheduled calls. | `scheduled_operation_rejects_config_change` | `configVersion`, `configHash`, scheduled calls | Lean models the scheduled commitment's config-version binding; concrete call hashing and full state rollback remain Solidity-tested. |
| `check_ValidatorCannotPerformGuardianRecoveryAction` | Validator authority cannot mutate guardian/recovery state directly. | `validator_cannot_perform_guardian_recovery_action` | `setGuardianConfig`, recovery entry points | Lean abstracts guardian recovery mutation to an actor-gated transition; proof domains and recovery payloads remain concrete. |
| `check_GuardianCannotPerformValidatorAction` | Guardian authority cannot become spending authority. | `guardian_cannot_perform_validator_action` | `execute`, caller/EntryPoint guards | Lean abstracts validator actions to an actor-gated transition; spending targets and proof domains remain concrete. |
| `check_PrivilegedAccountFunctionsRejectExternalCall` | Privileged lifecycle functions remain self-only. | `platform_actors_cannot_ordinary_execute_when_not_frozen` is related but insufficient. | schedule/cancel/install/uninstall/unfreeze self-call guards | The theorem covers ordinary execution, not privileged selector routing. |
| `check_MigrationDelayIsEnforced` | Migration cannot execute before its delay. | `migration_cannot_execute_before_delay` | `scheduleMigration`, `executeMigration`, `readyAt` | Lean models schedule delay, expiry, and time advancement, but not block-time irregularity. |
| `check_MigrationHashBinding` | Migration executes only its committed call batch. | `migration_rejects_mismatched_calls_hash` | `pendingMigration.callsHash`, `executeMigration` | Lean treats the hash as an abstract natural value; collision resistance and ABI encoding are concrete assumptions. |
| `check_MigrationBatchAtomicity` | A failed migration batch preserves pending state and effects. | `failed_batch_preserves_state` | `executeMigration`, batch loop, pending migration | Lean abstracts migration effects to the committed effect counter; pending-operation rollback remains concrete. |
| `check_GuardianProofCannotCountLeafTwice` | One guardian leaf cannot satisfy more than one threshold position. | Not modeled; this is a compiled-contract proof-verification property. | `GuardianVerificationLib.approved`, `RecoveryManager.proposeRecovery` | The property uses a verifier that accepts every signature so rejection depends on duplicate-leaf ordering. Merkle collision resistance and other guardian-consuming entry points remain assumptions. |
| `check_RecoveryDelayIsEnforced` | Recovery cannot execute before readiness. | `recovery_cannot_execute_before_delay` | `pendingRecoveries`, `executeRecovery`, `readyAt` | Lean models schedule delay, expiry, and time advancement, but not block-time irregularity. |
| `check_RecoveryReplacesValidatorSet` | Recovery installs a non-empty committed replacement set. | `recovery_requires_nonzero_replacement`, `recovery_installs_scheduled_validator_set` | `recoverConfigurationSet`, complete-set validation | Lean binds an abstract complete-set identity; validator ordering, key material, and guardian proof remain concrete. |
| `check_FrozenAccountOnlyAllowsRecoveryCancel` | Frozen guardian cancellation removes pending recovery without spending. | `frozen_guardian_cancel_recovery_allowed` | `_isFrozenSafe`, `cancelRecovery` | Guardian proof uniqueness and cancellation digest are abstracted. |
| `check_KeystoreUpdateRequiresController` | Only the identity controller can update keystore configuration. | `non_controller_keystore_update_preserves_state` | `LoomKeystore.updateConfig` | Lean abstracts controller identity to a Boolean; root/version tuple and signature verification remain concrete. |
| `check_SyncDelayIsEnforced` | Keystore sync cannot replace validators before delay. | `sync_cannot_execute_before_delay` | `proposeSync`, `executeSync`, `pendingSyncs.readyAt` | Lean abstracts sync payload and proof binding; concrete block-time and keystore identity remain concrete. |
| `check_GuardianCancellationGrantsNoValidatorAuthority` | Cancelling sync grants no validator authority. | `guardian_sync_cancellation_preserves_authority`, `approved_guardian_sync_cancellation_clears_pending` | `cancelSyncWithGuardians`, pending sync and validator set | Lean abstracts guardian proof and digest verification to an approval Boolean; validator addresses, proof uniqueness, and pending-sync payload remain concrete. |
| `check_VaultWithdrawalDelayIsEnforced` | Protected assets cannot leave before vault delay. | `vault_withdrawal_before_delay_preserves_state` | vault policy hook, `scheduleVaultWithdrawal`, account execution | Lean models abstract balances, pending state, and time; token semantics, hook classification, calldata binding, expiry, and config-version binding remain concrete. |
| `check_VaultGuardianCancellationGrantsNoSpendingAuthority` | Cancelling a withdrawal grants no spending authority. | `vault_guardian_cancellation_grants_no_spending_authority`, `approved_vault_guardian_cancellation_clears_pending` | `cancelVaultWithdrawalWithGuardians`, pending withdrawal | Lean abstracts guardian approval to a Boolean and spending authority to an identity; proof uniqueness, withdrawal identity, and token behavior remain concrete. |

## Abstract State Mapping

| Lean state | Concrete representation | Refinement status |
|---|---|---|
| `validatorCount` | `LoomAccount.validatorCount()` and installed validator modules | Count mapped; validator identities and init data are abstracted. |
| `configVersion` | `LoomAccount.configVersion()` | Directly mapped; scheduled commitments capture and require the current version; concrete `configHash` encoding remains an assumption. |
| `now` | `block.timestamp` | Abstract monotonic clock used for recovery timing; miner/validator timestamp constraints are out of scope. |
| `frozen` | `block.timestamp < LoomAccount.frozenUntil()` | Derived predicate mapped; the Lean Boolean omits the clock and expiry transition. |
| `recoveryPending` | `RecoveryManager.pendingRecoveries(account).readyAt != 0` | Predicate mapped; proposal digest and validator set are abstracted. |
| `recoveryReadyAt` | `RecoveryManager.pendingRecoveries(account).readyAt` | Direct timing value mapped; zero is cleared state. |
| `recoveryExpiresAt` | `RecoveryManager.pendingRecoveries(account).expiresAt` | Direct timing value mapped; execution remains valid at the exact expiry timestamp. |
| `validatorSetIdentity` | `LoomAccount`'s installed validator-set commitment | Abstract complete-set identity; module addresses, ordering, and initialization data remain concrete. |
| `recoveryValidatorSetIdentity` | `RecoveryManager.pendingRecoveries(account).newValidator` plus committed set payload | Abstract pending replacement identity; guardian approval and full set encoding remain concrete. |
| `migrationPending` | `LoomAccount.pendingMigration().readyAt != 0` | Predicate mapped independently from the target commitments represented by `migrationTarget`. |
| `migrationReadyAt` | `LoomAccount.pendingMigration().readyAt` | Direct timing value mapped; zero is cleared state and delay bounds remain concrete-only. |
| `migrationExpiresAt` | `LoomAccount.pendingMigration().expiresAt` | Direct timing value mapped; execution remains valid at the exact expiry timestamp. |
| `migrationTarget` | `pendingMigration.destination`, `destinationCodeHash`, `destinationConfigHash` | Destination and code hash match exactly; zero config hash preserves Solidity's optional config-binding semantics. |
| `migrationCallsHash` | `LoomAccount.pendingMigration().callsHash` | Abstract commitment mapped; Keccak collision resistance and `abi.encode(calls)` correctness remain concrete assumptions. |
| `migrationConfigVersion` | scheduled migration's `configVersion` binding | Abstract version binding; concrete pending-operation layout and hash encoding remain implementation details. |
| `directExecutionNonce` | `LoomAccount.directExecutionNonces(validator)` | Abstract single-validator nonce; concrete mapping keys and digest domain separation remain implementation details. |
| `batchEffect` | effects produced by an abstract execution batch | Abstract aggregate effect counter used only to state atomicity; concrete target storage and token balances remain external. |
| `initialized` | `LoomAccount.configVersion() != 0` plus initialized module/configuration state | Derived predicate mapped; storage-slot and proxy context are concrete-only. |
| `ProxyStoragePair.proxy` | account state stored at the proxy address | Separate initialization storage context; concrete Solidity slot layout is abstracted. |
| `ProxyStoragePair.implementation` | constructor-initialized state stored at the shared implementation address | Preserved by abstract proxy initialization; delegatecall context and bytecode semantics remain concrete. |
| `KeystoreSyncState.validatorSetIdentity` | currently installed account validator set | Preserved across guardian sync cancellation; concrete validator addresses and module initialization data are abstracted. |
| `KeystoreSyncState.guardianRoot` | `LoomAccount.guardianRoot()` | Preserved across guardian sync cancellation; guardian leaves and proof verification remain concrete. |
| `KeystoreSyncState.pending` | `pendingSyncs(account).readyAt != 0` | Cleared by an approved guardian cancellation. |
| `KeystoreSyncState.nonce` | `syncNonces(account)` | Incremented by an approved cancellation for replay protection. |
| `VaultState.now` / `readyAt` | `block.timestamp` / `pendingWithdrawals(account, withdrawalId).readyAt` | Abstract monotonic timing values; timestamp variance and liveness remain concrete assumptions. |
| `VaultState.protectedBalance` / `recipientBalance` | protected asset balances of the account and withdrawal recipient | Abstract balance pair; ERC-20 return values, callbacks, rebasing, and fee behavior remain concrete. |
| `VaultState.spendingAuthorityIdentity` | installed validator and policy authority governing ordinary vault spending | Preserved by guardian cancellation; module addresses, signatures, and policy fields are abstracted. |
| `VaultState.pending` | `pendingWithdrawals(account, withdrawalId).readyAt != 0` | Cleared by execution or approved guardian cancellation. |

## Abstract Transition Mapping

| Lean transition | Concrete entry points | Preconditions represented in Lean | Concrete-only preconditions |
|---|---|---|---|
| `ordinaryExecute` | `execute`, `executeDirect` | not frozen; abstract actor allowed | EntryPoint, validator signature, nonce, hooks, execution mode, call success |
| `freezeByGuardian` | `freeze` | none | guardian root, threshold, unique proofs, config binding |
| `scheduleRecovery` | `RecoveryManager.proposeRecovery` | records timing and the complete replacement-set identity | module installation, proposal hash, validator ordering, fixed delay/window constants |
| `cancelRecoveryByGuardian` | `RecoveryManager.cancelRecovery` | frozen and pending | proof verification, exact cancellation digest, operation identity |
| `executeRecovery` | `RecoveryManager.executeRecovery` then account recovery functions | pending, `readyAt <= now <= expiresAt`, non-zero replacement | exact set replacement, proof/digest and config binding |
| `advanceTime` | passage of chain time between transactions | adds a non-negative delta to `now` | block production, timestamp variance, reorgs, and liveness |
| `configChange` | successful scheduled self-calls that mutate modules or guardian configuration | version increments abstractly and invalidates commitments bound to an older version | scheduling delay, operation hash, exact changed state, stale invalidation |
| `scheduleMigration` | `scheduleMigration` | records target identity/code/config bindings, `readyAt`, `expiresAt`, and the call commitment | deployed-code checks, config read validity, delay/window bounds |
| `executeMigration` | `executeMigration` | pending, not frozen, within the execution window, matching target, call, and config-version commitments | hook mediation and atomic external calls |
| `executeDirectAttempt` | `executeDirect` | rejected authorization leaves the nonce unchanged | signature verification, validity window, validator installation, and nonce-map selection |
| `executeBatch` | `_executeAuthorized`, `executeDirect`, and `executeMigration` batch loops | failed execution returns the original state; successful execution commits all abstract effects together | EVM revert propagation, external-call side effects, nonce rollback, and token semantics |
| `executionModeAttempt` | `execute` | unsupported modes return the original account state without executing | ERC-7579 mode layout, decoder, target calls, and exact revert data |
| `guardianlessFreezeAttempt` | `freeze` and guardian configuration guards | an unconfigured guardian set cannot change frozen state | guardian proof verification, root/threshold storage, and exact revert data |
| `guardianConfigAttempt` | `setGuardianConfig` | external callers return the original authority state; only self-calls may increment configuration | guardian root, threshold, proof routing, and exact revert data |
| `delegatedInitialize` | `initializeDelegatedAccount` | external callers return the original state; only self-calls may set initialized | proxy delegatecall context, initialization payload, and module setup |
| `initializeProxyStorage` | `LoomAccountProxy` constructor delegatecall to `LoomAccount.initialize` | proxy config version and validator-set identity are replaced while implementation storage is preserved | EVM delegatecall context, exact storage slots, initialization calldata, and module initialization side effects |
| `validatorActionAttempt` | validator module actions through `execute` | guardian actor returns the original state; only validator actor may change the validator-set count | validator signatures, module selectors, and target side effects |
| `recoveryConfigurationAttempt` | `recoverConfiguration`, `recoverConfigurationSet` | external callers return the original authority state; only the installed recovery module may change configuration | validator-set payload, guardian proof, module routing, and exact revert data |
| `guardianRecoveryActionAttempt` | guardian recovery and guardian configuration entry points | validator actors return the original authority state; only guardian actors may mutate recovery configuration | guardian proof verification, recovery digest, and module routing |
| `keystoreConfigAttempt` | `LoomKeystore.updateConfig` | non-controller callers return the original authority state; only the controller may update configuration | controller identity proof, root/version tuple, and storage layout |
| `syncAttempt` | `proposeSync`, `executeSync` | execution before `readyAt` returns the original validator-set state | keystore proof, validator-root binding, and pending-sync storage |
| `cancelKeystoreSyncWithGuardians` | `cancelSyncWithGuardians` | an approved cancellation clears pending state and advances its nonce without changing validator-set identity or guardian root | guardian threshold, proof uniqueness, cancellation digest, validator addresses, and pending payload |
| `executeVaultWithdrawal` | vault hook `preCheck` for an account execution matching a pending withdrawal | execution before `readyAt` returns the original vault state; ready execution may transfer the abstract amount and clear pending state | token call semantics, policy classification, withdrawal hash, expiry, config version, account scheduling, and hook rollback |
| `cancelVaultWithdrawalWithGuardians` | `cancelVaultWithdrawalWithGuardians` | approved cancellation clears pending state without changing balances or spending-authority identity | guardian threshold, proof uniqueness, cancellation digest, withdrawal identity, and token behavior |
| `initialize` | `initialize`, `initializeDelegatedAccount` | not already initialized | proxy context, self-call restriction, module initialization payload |
| `upgradeImplementation` | no supported entry point | always rejected | bytecode-level absence of upgrade/admin selectors |

## Lean Theorem Coverage

Every current theorem has at least one concrete review anchor:

- `frozen_blocks_ordinary_execution`: frozen EntryPoint and direct-execution properties;
- `initialized_state_rejects_reinitialization`: one-shot initialization property;
- `proxy_initialization_updates_only_proxy_storage`: immutable proxy initialization storage-isolation property;
- `guardian_sync_cancellation_preserves_authority`: guardian keystore-sync cancellation non-authority property;
- `approved_guardian_sync_cancellation_clears_pending`: successful guardian sync-cancellation liveness property;
- `vault_withdrawal_before_delay_preserves_state`: vault withdrawal delay safety property;
- `vault_guardian_cancellation_grants_no_spending_authority`: guardian vault-cancellation non-authority property;
- `approved_vault_guardian_cancellation_clears_pending`: successful guardian vault-cancellation liveness property;
- `immutable_proxy_has_no_upgrade_transition`: immutable proxy selector property;
- `frozen_guardian_cancel_recovery_allowed`: frozen recovery-cancel property;
- `recovery_requires_nonzero_replacement`: recovery replacement and last-validator properties;
- `recovery_cannot_execute_before_delay`: recovery delay symbolic and integration properties;
- `recovery_cannot_execute_after_expiry`: recovery execution-window integration properties;
- `recovery_installs_scheduled_validator_set`: exact recovery replacement identity integration properties;
- `recovery_rejects_mismatched_validator_set`: recovery replacement binding integration properties;
- `migration_cannot_execute_before_delay`: migration delay symbolic and integration properties;
- `migration_rejects_mismatched_calls_hash`: migration call-hash binding symbolic and integration properties;
- `migration_cannot_execute_after_expiry`: migration execution-window integration properties;
- `migration_rejects_mismatched_target`: migration destination/code/config binding integration properties;
- `migration_target_zero_config_is_wildcard`: optional destination-config binding semantics;
- `migration_rejects_changed_bound_config`: non-zero destination-config binding integrity;
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
