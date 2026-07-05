// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

/// @notice Adversarial hook that attempts to modify storage via a delegatecall
///         during preCheck or postCheck.  Verifies that the account's reentrancy
///         guard correctly blocks any secondary execution from within a hook.
contract StorageModifyingHook is ILoomHook {
    /// @dev Slot the hook tries to overwrite using a raw SSTORE (in the hook's
    ///      own storage, not the account's — the account runs this via CALL not
    ///      DELEGATECALL, so the write lands here, not in the account).
    uint256 public preCheckWriteCount;
    uint256 public postCheckWriteCount;
    bool public attemptReentryOnPreCheck;
    bool public attemptReentryOnPostCheck;
    bool public reentrySucceededInPreCheck;
    bool public reentrySucceededInPostCheck;

    function setAttemptReentryOnPreCheck(bool value) external {
        attemptReentryOnPreCheck = value;
    }

    function setAttemptReentryOnPostCheck(bool value) external {
        attemptReentryOnPostCheck = value;
    }

    function preCheck(address account, address, bytes calldata) external returns (bytes memory) {
        preCheckWriteCount++;
        if (attemptReentryOnPreCheck) {
            // Attempt reentrancy — must be rejected by the account's _executionLocked guard.
            (bool ok,) = account.call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(this), 0, "")))
                )
            );
            reentrySucceededInPreCheck = ok;
        }
        return abi.encode(preCheckWriteCount);
    }

    function postCheck(address account, bytes calldata) external {
        postCheckWriteCount++;
        if (attemptReentryOnPostCheck) {
            (bool ok,) = account.call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(this), 0, "")))
                )
            );
            reentrySucceededInPostCheck = ok;
        }
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }

    receive() external payable {}
}
