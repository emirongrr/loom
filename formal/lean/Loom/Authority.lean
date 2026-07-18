namespace Loom

inductive Actor where
  | account
  | validator
  | guardian
  | external
  | developer
  | factory
  | registry
  | provider
  | proxy
  deriving DecidableEq, Repr

structure MigrationTarget where
  destination : Nat
  codeHash : Nat
  configHash : Nat
  deriving DecidableEq, Repr

def emptyMigrationTarget : MigrationTarget :=
  { destination := 0, codeHash := 0, configHash := 0 }

inductive Transition where
  | ordinaryExecute (actor : Actor)
  | freezeByGuardian
  | scheduleRecovery
      (delay : Nat)
      (executionWindow : Nat)
      (replacementIdentity : Nat)
  | cancelRecoveryByGuardian
  | executeRecovery (newValidatorCount : Nat) (replacementIdentity : Nat)
  | advanceTime (delta : Nat)
  | configChange
  | scheduleMigration
      (delay : Nat)
      (executionWindow : Nat)
      (target : MigrationTarget)
      (callsHash : Nat)
  | executeMigration (observedTarget : MigrationTarget) (callsHash : Nat)
  | initialize
  | upgradeImplementation (actor : Actor)
  deriving DecidableEq, Repr

structure State where
  validatorCount : Nat
  validatorSetIdentity : Nat
  configVersion : Nat
  now : Nat
  frozen : Bool
  recoveryPending : Bool
  recoveryReadyAt : Nat
  recoveryExpiresAt : Nat
  recoveryValidatorSetIdentity : Nat
  migrationPending : Bool
  migrationReadyAt : Nat
  migrationExpiresAt : Nat
  migrationTarget : MigrationTarget
  migrationCallsHash : Nat
  migrationConfigVersion : Nat
  directExecutionNonce : Nat
  batchEffect : Nat
  initialized : Bool
  deriving Repr

def executeDirectAttempt (s : State) (authorized : Bool) : State × Bool :=
  if authorized then
    ({ s with directExecutionNonce := s.directExecutionNonce + 1 }, true)
  else
    (s, false)
def executeBatch (s : State) (firstEffect secondEffect : Nat) (fails : Bool) : State × Bool :=
  if fails then
    (s, false)
  else
    ({ s with batchEffect := s.batchEffect + firstEffect + secondEffect }, true)

def hasValidator (s : State) : Prop :=
  s.validatorCount > 0

def executionModeAttempt (s : State) (modeSupported : Bool) : State × Bool :=
  if modeSupported then
    (s, true)
def validatorActionAttempt (s : State) (actor : Actor) : State × Bool :=
  if actor = Actor.validator then
    ({ s with validatorCount := s.validatorCount + 1 }, true)
def recoveryConfigurationAttempt (s : State) (callerIsRecoveryModule : Bool) : State × Bool :=
  if callerIsRecoveryModule then
    ({ s with configVersion := s.configVersion + 1 }, true)
  else
    (s, false)

def noPlatformAuthority (actor : Actor) : Prop :=
  actor != Actor.developer
    /\ actor != Actor.factory
    /\ actor != Actor.registry
    /\ actor != Actor.provider
    /\ actor != Actor.proxy

def ordinaryActorAllowed : Actor -> Bool
  | Actor.account => true
  | Actor.validator => true
  | _ => false

def migrationTargetMatches (scheduled observed : MigrationTarget) : Prop :=
  scheduled.destination = observed.destination
    /\ scheduled.codeHash = observed.codeHash
    /\ (scheduled.configHash = 0 \/ scheduled.configHash = observed.configHash)

def step (s : State) : Transition -> Option State
  | Transition.ordinaryExecute actor =>
      if s.frozen = true then
        none
      else if ordinaryActorAllowed actor = true then
        some s
      else
        none
  | Transition.freezeByGuardian =>
      some { s with frozen := true }
  | Transition.scheduleRecovery delay executionWindow replacementIdentity =>
      some {
        s with
          recoveryPending := true,
          recoveryReadyAt := s.now + delay,
          recoveryExpiresAt := s.now + delay + executionWindow,
          recoveryValidatorSetIdentity := replacementIdentity
      }
  | Transition.cancelRecoveryByGuardian =>
      if s.frozen = true /\ s.recoveryPending = true then
        some {
          s with
            recoveryPending := false,
            recoveryReadyAt := 0,
            recoveryExpiresAt := 0,
            recoveryValidatorSetIdentity := 0
        }
      else
        none
  | Transition.executeRecovery newValidatorCount replacementIdentity =>
      if s.recoveryPending = true /\ s.recoveryReadyAt <= s.now
          /\ s.now <= s.recoveryExpiresAt /\ newValidatorCount > 0
          /\ replacementIdentity = s.recoveryValidatorSetIdentity then
        some {
          s with
            validatorCount := newValidatorCount,
            validatorSetIdentity := replacementIdentity,
            configVersion := s.configVersion + 1,
            recoveryPending := false,
            recoveryReadyAt := 0,
            recoveryExpiresAt := 0,
            recoveryValidatorSetIdentity := 0
        }
      else
        none
  | Transition.advanceTime delta =>
      some { s with now := s.now + delta }
  | Transition.configChange =>
      some { s with configVersion := s.configVersion + 1 }
  | Transition.scheduleMigration delay executionWindow target callsHash =>
      some {
        s with
          migrationPending := true,
          migrationReadyAt := s.now + delay,
          migrationExpiresAt := s.now + delay + executionWindow,
          migrationTarget := target,
          migrationCallsHash := callsHash,
          migrationConfigVersion := s.configVersion
      }
  | Transition.executeMigration observedTarget callsHash =>
      if s.frozen = true \/ s.migrationPending = false \/ s.now < s.migrationReadyAt
          \/ s.migrationExpiresAt < s.now \/ ¬ migrationTargetMatches s.migrationTarget observedTarget
          \/ callsHash != s.migrationCallsHash \/ s.migrationConfigVersion != s.configVersion then
        none
      else
        some {
          s with
            migrationPending := false,
            migrationReadyAt := 0,
            migrationExpiresAt := 0,
            migrationTarget := emptyMigrationTarget,
            migrationCallsHash := 0,
            migrationConfigVersion := 0
        }
  | Transition.initialize =>
      if s.initialized = true then none else some { s with initialized := true }
  | Transition.upgradeImplementation _ =>
      none

theorem frozen_blocks_ordinary_execution (s : State) (actor : Actor) :
    s.frozen = true -> step s (Transition.ordinaryExecute actor) = none := by
  intro h
  simp [step, h]

theorem unsupported_execution_mode_preserves_state
    (s : State) :
    (executionModeAttempt s false).1 = s := by
  simp [executionModeAttempt]
theorem guardian_cannot_perform_validator_action
    (s : State) :
    (validatorActionAttempt s Actor.guardian).1 = s := by
  simp [validatorActionAttempt]
theorem external_recovery_preserves_authority_state
    (s : State) :
    (recoveryConfigurationAttempt s false).1 = s := by
  simp [recoveryConfigurationAttempt]

theorem initialized_state_rejects_reinitialization (s : State) :
    s.initialized = true -> step s Transition.initialize = none := by
  intro h
  simp [step, h]

theorem immutable_proxy_has_no_upgrade_transition (s : State) (actor : Actor) :
    step s (Transition.upgradeImplementation actor) = none := by
  simp [step]

theorem frozen_guardian_cancel_recovery_allowed (s : State) :
    s.frozen = true ->
    s.recoveryPending = true ->
    step s Transition.cancelRecoveryByGuardian =
      some {
        s with
          recoveryPending := false,
          recoveryReadyAt := 0,
          recoveryExpiresAt := 0,
          recoveryValidatorSetIdentity := 0
      } := by
  intro hf hp
  simp [step, hf, hp]

theorem recovery_requires_nonzero_replacement
    (s s' : State)
    (newValidatorCount : Nat)
    (replacementIdentity : Nat) :
    step s (Transition.executeRecovery newValidatorCount replacementIdentity) = some s' ->
    s'.validatorCount > 0 := by
  intro hstep
  unfold step at hstep
  by_cases h :
      s.recoveryPending = true /\ s.recoveryReadyAt <= s.now
        /\ s.now <= s.recoveryExpiresAt /\ newValidatorCount > 0
        /\ replacementIdentity = s.recoveryValidatorSetIdentity
  · simp [h] at hstep
    cases hstep
    exact h.2.2.2.1
  · simp [h] at hstep

theorem recovery_installs_scheduled_validator_set
    (s s' : State)
    (newValidatorCount : Nat)
    (replacementIdentity : Nat) :
    step s (Transition.executeRecovery newValidatorCount replacementIdentity) = some s' ->
    s'.validatorSetIdentity = replacementIdentity := by
  intro hstep
  unfold step at hstep
  by_cases h :
      s.recoveryPending = true /\ s.recoveryReadyAt <= s.now
        /\ s.now <= s.recoveryExpiresAt /\ newValidatorCount > 0
        /\ replacementIdentity = s.recoveryValidatorSetIdentity
  · simp [h] at hstep
    cases hstep
    rfl
  · simp [h] at hstep

theorem recovery_rejects_mismatched_validator_set
    (s : State)
    (newValidatorCount : Nat)
    (replacementIdentity : Nat) :
    replacementIdentity != s.recoveryValidatorSetIdentity ->
    step s (Transition.executeRecovery newValidatorCount replacementIdentity) = none := by
  intro hmismatch
  simp [step, hmismatch]

theorem recovery_cannot_execute_before_delay
    (s : State)
    (newValidatorCount : Nat)
    (replacementIdentity : Nat) :
    s.recoveryPending = true ->
    s.now < s.recoveryReadyAt ->
    step s (Transition.executeRecovery newValidatorCount replacementIdentity) = none := by
  intro hp hbefore
  simp [step, hp, Nat.not_le_of_gt hbefore]

theorem recovery_cannot_execute_after_expiry
    (s : State)
    (newValidatorCount : Nat)
    (replacementIdentity : Nat) :
    s.recoveryExpiresAt < s.now ->
    step s (Transition.executeRecovery newValidatorCount replacementIdentity) = none := by
  intro hexpired
  simp [step, Nat.not_le_of_gt hexpired]

theorem migration_cannot_execute_before_delay
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    s.migrationPending = true ->
    s.now < s.migrationReadyAt ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hp hbefore
  simp [step, hp, hbefore]

theorem migration_rejects_mismatched_calls_hash
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    callsHash != s.migrationCallsHash ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hmismatch
  simp [step, hmismatch]

theorem migration_cannot_execute_after_expiry
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    s.migrationExpiresAt < s.now ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hexpired
  simp [step, hexpired]

theorem migration_rejects_mismatched_target
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    ¬ migrationTargetMatches s.migrationTarget observedTarget ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hmismatch
  simp [step, hmismatch]

theorem migration_target_zero_config_is_wildcard
    (scheduled observed : MigrationTarget) :
    scheduled.destination = observed.destination ->
    scheduled.codeHash = observed.codeHash ->
    scheduled.configHash = 0 ->
    migrationTargetMatches scheduled observed := by
  intro hdestination hcode hconfig
  simp [migrationTargetMatches, hdestination, hcode, hconfig]

theorem migration_rejects_changed_bound_config
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    s.migrationTarget.configHash != 0 ->
    s.migrationTarget.configHash != observedTarget.configHash ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hbound hchanged
  apply migration_rejects_mismatched_target
  simp [migrationTargetMatches, hbound, hchanged]

theorem scheduled_operation_rejects_config_change
    (s : State)
    (observedTarget : MigrationTarget)
    (callsHash : Nat) :
    s.migrationConfigVersion != s.configVersion ->
    step s (Transition.executeMigration observedTarget callsHash) = none := by
  intro hchanged
  simp [step, hchanged]

theorem rejected_direct_execution_preserves_nonce
    (s : State) :
    (executeDirectAttempt s false).1.directExecutionNonce = s.directExecutionNonce := by
  simp [executeDirectAttempt]
theorem failed_batch_preserves_state
    (s : State)
    (firstEffect secondEffect : Nat) :
    (executeBatch s firstEffect secondEffect true).1 = s := by
  simp [executeBatch]

theorem successful_batch_commits_all_effects
    (s : State)
    (firstEffect secondEffect : Nat) :
    (executeBatch s firstEffect secondEffect false).1.batchEffect =
      s.batchEffect + firstEffect + secondEffect := by
  simp [executeBatch]

theorem platform_actors_cannot_ordinary_execute_when_not_frozen
    (s : State)
    (actor : Actor) :
    actor = Actor.developer
      \/ actor = Actor.factory
      \/ actor = Actor.registry
      \/ actor = Actor.provider
      \/ actor = Actor.proxy ->
    s.frozen = false ->
    step s (Transition.ordinaryExecute actor) = none := by
  intro hplatform hf
  rcases hplatform with hdev | hfactory | hregistry | hprovider | hproxy
  · subst actor
    simp [step, hf, ordinaryActorAllowed]
  · subst actor
    simp [step, hf, ordinaryActorAllowed]
  · subst actor
    simp [step, hf, ordinaryActorAllowed]
  · subst actor
    simp [step, hf, ordinaryActorAllowed]
  · subst actor
    simp [step, hf, ordinaryActorAllowed]

theorem successful_step_preserves_validator_nonzero
    (s s' : State)
    (t : Transition) :
    hasValidator s ->
    step s t = some s' ->
    hasValidator s' := by
  intro hs hstep
  cases t with
  | ordinaryExecute actor =>
      unfold step at hstep
      by_cases hf : s.frozen = true
      · simp [hf] at hstep
      · simp [hf] at hstep
        by_cases ha : ordinaryActorAllowed actor = true
        · simp [ha] at hstep
          cases hstep
          exact hs
        · simp [ha] at hstep
  | freezeByGuardian =>
      simp [step, hasValidator] at hstep
      cases hstep
      exact hs
  | scheduleRecovery delay executionWindow replacementIdentity =>
      simp [step, hasValidator] at hstep
      cases hstep
      exact hs
  | cancelRecoveryByGuardian =>
      unfold step at hstep
      by_cases h : s.frozen = true /\ s.recoveryPending = true
      · simp [h, hasValidator] at hstep
        cases hstep
        exact hs
      · simp [h] at hstep
  | executeRecovery newValidatorCount replacementIdentity =>
      exact recovery_requires_nonzero_replacement s s' newValidatorCount replacementIdentity hstep
  | advanceTime delta =>
      simp [step, hasValidator] at hstep
      cases hstep
      exact hs
  | configChange =>
      simp [step, hasValidator] at hstep
      cases hstep
      exact hs
  | scheduleMigration delay executionWindow target callsHash =>
      simp [step, hasValidator] at hstep
      cases hstep
      exact hs
  | executeMigration observedTarget callsHash =>
      unfold step at hstep
      by_cases h : s.frozen = true \/ s.migrationPending = false \/ s.now < s.migrationReadyAt
          \/ s.migrationExpiresAt < s.now \/ ¬ migrationTargetMatches s.migrationTarget observedTarget
          \/ callsHash != s.migrationCallsHash
      · simp [h] at hstep
      · simp [h, hasValidator] at hstep
        cases hstep
        exact hs
  | initialize =>
      unfold step at hstep
      by_cases h : s.initialized = true
      · simp [h] at hstep
      · simp [h, hasValidator] at hstep
        cases hstep
        exact hs
  | upgradeImplementation actor =>
      simp [step] at hstep

theorem config_version_never_decreases_on_success
    (s s' : State)
    (t : Transition) :
    step s t = some s' ->
    s.configVersion <= s'.configVersion := by
  intro hstep
  cases t with
  | ordinaryExecute actor =>
      unfold step at hstep
      by_cases hf : s.frozen = true
      · simp [hf] at hstep
      · simp [hf] at hstep
        by_cases ha : ordinaryActorAllowed actor = true
        · simp [ha] at hstep
          cases hstep
          exact Nat.le_refl s.configVersion
        · simp [ha] at hstep
  | freezeByGuardian =>
      simp [step] at hstep
      cases hstep
      exact Nat.le_refl s.configVersion
  | scheduleRecovery delay executionWindow replacementIdentity =>
      simp [step] at hstep
      cases hstep
      exact Nat.le_refl s.configVersion
  | cancelRecoveryByGuardian =>
      unfold step at hstep
      by_cases h : s.frozen = true /\ s.recoveryPending = true
      · simp [h] at hstep
        cases hstep
        exact Nat.le_refl s.configVersion
      · simp [h] at hstep
  | executeRecovery newValidatorCount replacementIdentity =>
      unfold step at hstep
      by_cases h :
          s.recoveryPending = true /\ s.recoveryReadyAt <= s.now
            /\ s.now <= s.recoveryExpiresAt /\ newValidatorCount > 0
            /\ replacementIdentity = s.recoveryValidatorSetIdentity
      · simp [h] at hstep
        cases hstep
        exact Nat.le_succ s.configVersion
      · simp [h] at hstep
  | configChange =>
      simp [step] at hstep
      cases hstep
      exact Nat.le_succ s.configVersion
  | advanceTime delta =>
      simp [step] at hstep
      cases hstep
      exact Nat.le_refl s.configVersion
  | scheduleMigration delay executionWindow target callsHash =>
      simp [step] at hstep
      cases hstep
      exact Nat.le_refl s.configVersion
  | executeMigration observedTarget callsHash =>
      unfold step at hstep
      by_cases h : s.frozen = true \/ s.migrationPending = false \/ s.now < s.migrationReadyAt
          \/ s.migrationExpiresAt < s.now \/ ¬ migrationTargetMatches s.migrationTarget observedTarget
          \/ callsHash != s.migrationCallsHash
      · simp [h] at hstep
      · simp [h] at hstep
        cases hstep
        exact Nat.le_refl s.configVersion
  | initialize =>
      unfold step at hstep
      by_cases h : s.initialized = true
      · simp [h] at hstep
      · simp [h] at hstep
        cases hstep
        exact Nat.le_refl s.configVersion
  | upgradeImplementation actor =>
      simp [step] at hstep

end Loom
