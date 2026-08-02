// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

/// @notice A validator module that calls `initialize` back on the account while
/// that account is still inside its own constructor.
/// @dev `_initialize` installs modules by calling into them, so a module runs
/// inside the one context the initialization-context guard in `initialize`
/// deliberately allows: an account whose `address(this).code.length` is still zero.
/// This module exists to show that context cannot be reached by an external call
/// at all. An account under construction has no code, so the call dispatches
/// nothing, returns success with empty returndata, and leaves state untouched —
/// only the proxy constructor's own delegatecall executes the runtime there.
/// It records the outcome instead of reverting so a test can assert it exactly.
contract InitializerReentrantModule {
    bool public reentryAttempted;
    bool public reentryCallSucceeded;
    bytes public reentryReturnData;
    uint256 public accountCodeSizeDuringInstall;

    function initialize() external {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(this), "");

        reentryAttempted = true;
        accountCodeSizeDuringInstall = msg.sender.code.length;
        (bool ok, bytes memory returnData) = msg.sender
            .call(
                abi.encodeCall(
                    LoomAccount.initialize,
                    (msg.sender, keccak256("reentrant-guardians"), uint8(1), keccak256("reentrant-config"), modules)
                )
            );
        reentryCallSucceeded = ok;
        reentryReturnData = returnData;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
