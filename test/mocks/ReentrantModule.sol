// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract ReentrantModule is ILoomHook {
    function initialize() external {
        LoomAccount(payable(msg.sender))
            .execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(this), 0, abi.encodeCall(this.noop, ()))));
    }

    function noop() external pure {}

    function preCheck(address, address, bytes calldata) external pure returns (bytes memory) {
        return "";
    }

    function postCheck(address, bytes calldata) external pure {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK || moduleTypeId == ModuleType.VALIDATOR;
    }
}
