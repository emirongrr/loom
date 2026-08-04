// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice An account stub that records a validator's policy hook and then reports
/// that hook as not installed.
/// @dev Validators fail closed when their bound policy hook is missing, and that
/// branch is worth testing. A real `LoomAccount` can no longer be driven into that
/// state -- it refuses to remove a hook an installed validator depends on -- so
/// reaching the branch through one is impossible by design.
///
/// This stub reaches it directly. It initializes the validator against itself, so
/// the validator records the hook, and then answers `isModuleInstalled` with false.
/// That keeps the validator's own defence covered for the cases the account cannot
/// vouch for: a validator deployed against a non-Loom account, a future account
/// version, or a Loom account whose invariants have been broken some other way.
contract UninstalledHookAccount {
    function initializeValidator(address validator, bytes calldata initData) external {
        (bool ok, bytes memory result) = validator.call(initData);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @notice Always false: nothing is installed on this stub.
    function isModuleInstalled(uint256, address) external pure returns (bool) {
        return false;
    }

    function isExecutingScheduled() external pure returns (bool) {
        return false;
    }

    function isEvictingHook() external pure returns (bool) {
        return false;
    }

    function configVersion() external pure returns (uint64) {
        return 1;
    }
}
