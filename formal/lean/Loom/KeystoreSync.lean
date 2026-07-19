namespace Loom

structure KeystoreSyncState where
  validatorSetIdentity : Nat
  guardianRoot : Nat
  pending : Bool
  nonce : Nat
  deriving DecidableEq, Repr

def cancelKeystoreSyncWithGuardians
    (state : KeystoreSyncState)
    (approved : Bool) : KeystoreSyncState × Bool :=
  if approved && state.pending then
    ({ state with pending := false, nonce := state.nonce + 1 }, true)
  else
    (state, false)

theorem guardian_sync_cancellation_preserves_authority
    (state : KeystoreSyncState)
    (approved : Bool) :
    let updated := (cancelKeystoreSyncWithGuardians state approved).1
    updated.validatorSetIdentity = state.validatorSetIdentity
      /\ updated.guardianRoot = state.guardianRoot := by
  simp [cancelKeystoreSyncWithGuardians]

theorem approved_guardian_sync_cancellation_clears_pending
    (state : KeystoreSyncState) :
    state.pending = true ->
    (cancelKeystoreSyncWithGuardians state true).1.pending = false := by
  intro hpending
  simp [cancelKeystoreSyncWithGuardians, hpending]

end Loom
