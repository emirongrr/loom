// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract ReentrantHook is ILoomHook {
    bool public reenteredInPreCheck;
    bool public reenteredInPostCheck;
    bool public reenterOnPreCheck;
    bool public reenterOnPostCheck;
    bytes public preCheckRevertData;
    bytes public postCheckRevertData;

    function setReenterOnPreCheck(bool value) external {
        reenterOnPreCheck = value;
    }

    function setReenterOnPostCheck(bool value) external {
        reenterOnPostCheck = value;
    }

    function preCheck(address account, address, bytes calldata) external returns (bytes memory) {
        if (reenterOnPreCheck) {
            (bool ok, bytes memory result) = account.call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(this), 0, "")))
                )
            );
            reenteredInPreCheck = ok;
            preCheckRevertData = result;
        }
        return "";
    }

    function postCheck(address account, bytes calldata) external {
        if (reenterOnPostCheck) {
            (bool ok, bytes memory result) = account.call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(this), 0, "")))
                )
            );
            reenteredInPostCheck = ok;
            postCheckRevertData = result;
        }
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }

    receive() external payable {}

    fallback() external payable {}
}
