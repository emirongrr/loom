// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {IPolicyHook} from "../../src/interfaces/IPolicyHook.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract MockPolicyHook is ILoomHook, IPolicyHook {
    function isLowRisk(address, bytes calldata) external pure returns (bool) {
        return true;
    }

    function preCheck(address, address, bytes calldata) external pure returns (bytes memory) {
        return "";
    }

    function postCheck(address, bytes calldata) external pure {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }
}
