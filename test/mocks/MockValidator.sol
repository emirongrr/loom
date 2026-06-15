// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../../src/interfaces/ILoomValidator.sol";
import {ILoomDirectValidator} from "../../src/interfaces/ILoomDirectValidator.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract MockValidator is ILoomValidator, ILoomDirectValidator {
    function validateUserOp(address, bytes32, uint256, bytes calldata, bytes calldata, address)
        external
        pure
        returns (uint256)
    {
        return 0;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return true;
    }

    function validateDirectExecution(address, bytes32, bytes calldata, bytes calldata) external pure returns (bool) {
        return true;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
