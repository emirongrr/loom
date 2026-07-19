namespace Loom

structure VaultState where
  now : Nat
  readyAt : Nat
  protectedBalance : Nat
  recipientBalance : Nat
  spendingAuthorityIdentity : Nat
  pending : Bool
  deriving DecidableEq, Repr

def executeVaultWithdrawal
    (state : VaultState)
    (amount : Nat) : VaultState × Bool :=
  if state.pending && state.readyAt <= state.now && amount <= state.protectedBalance then
    (
      {
        state with
          protectedBalance := state.protectedBalance - amount,
          recipientBalance := state.recipientBalance + amount,
          pending := false
      },
      true
    )
  else
    (state, false)

def cancelVaultWithdrawalWithGuardians
    (state : VaultState)
    (approved : Bool) : VaultState × Bool :=
  if approved && state.pending then
    ({ state with pending := false }, true)
  else
    (state, false)

theorem vault_withdrawal_before_delay_preserves_state
    (state : VaultState)
    (amount : Nat) :
    state.now < state.readyAt ->
    (executeVaultWithdrawal state amount).1 = state := by
  intro hbefore
  simp [executeVaultWithdrawal, Nat.not_le_of_gt hbefore]

theorem vault_guardian_cancellation_grants_no_spending_authority
    (state : VaultState)
    (approved : Bool) :
    let updated := (cancelVaultWithdrawalWithGuardians state approved).1
    updated.protectedBalance = state.protectedBalance
      /\ updated.recipientBalance = state.recipientBalance
      /\ updated.spendingAuthorityIdentity = state.spendingAuthorityIdentity := by
  simp [cancelVaultWithdrawalWithGuardians]

theorem approved_vault_guardian_cancellation_clears_pending
    (state : VaultState) :
    state.pending = true ->
    (cancelVaultWithdrawalWithGuardians state true).1.pending = false := by
  intro hpending
  simp [cancelVaultWithdrawalWithGuardians, hpending]

end Loom
