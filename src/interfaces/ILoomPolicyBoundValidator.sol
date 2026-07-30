// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Implemented by validators whose validation depends on a policy hook
/// being installed on the account.
/// @dev Every built-in primary validator stores a policy-hook address per account
/// and fails closed when that hook is not installed. Without a way to ask a
/// validator what it depends on, the account could remove a hook that its only
/// validator needed, which left the account unable to authorize anything: neither
/// `validateUserOp` nor `validateDirectExecution` could pass, `setPolicyHook`
/// requires a scheduled self-call that only a passing validator can reach, and
/// recovery installs validators but not hooks, so it could not repair the state
/// either.
///
/// Declaring the dependency makes it enforceable. The account refuses to remove a
/// hook an installed validator depends on, and the guardian eviction path can
/// swap a stuck hook for a working one atomically instead of stranding the
/// account.
///
/// Implementing this interface is optional. A validator that needs no policy hook
/// simply does not implement it, and the account treats it as depending on
/// nothing.
interface ILoomPolicyBoundValidator {
    /// @notice The policy hook this validator requires for `account`.
    /// @return The hook address, or the zero address when the validator has no
    /// policy-hook dependency for that account.
    function policyHookFor(address account) external view returns (address);

    /// @notice Re-point this validator at `newHook` for the calling account.
    /// @dev Callable only by the account, and only while the account reports
    /// `isEvictingHook()`. That restriction matters: ordinary hook changes go
    /// through `setPolicyHook`, which requires the account's configuration
    /// timelock. Without the eviction gate this would be an instant, untimelocked
    /// way to re-point a validator at a permissive hook.
    ///
    /// Implementations must require `newHook` to be installed on the account.
    function rebindPolicyHook(address newHook) external;
}
