// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract RevertingHook is ILoomHook {
    error HookReverted();

    function preCheck(address, address, bytes calldata) external pure returns (bytes memory) {
        revert HookReverted();
    }

    function postCheck(address, bytes calldata) external pure {
        revert HookReverted();
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }
}
