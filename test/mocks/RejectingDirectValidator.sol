// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomDirectValidator} from "../../src/interfaces/ILoomDirectValidator.sol";
import {ILoomValidator} from "../../src/interfaces/ILoomValidator.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";

contract RejectingDirectValidator is ILoomValidator, ILoomDirectValidator {
    function validateUserOp(address, bytes32, uint256, bytes calldata, bytes calldata, address)
        external
        pure
        returns (uint256)
    {
        return ValidationDataLib.SIG_VALIDATION_FAILED;
    }

    function validateDirectExecution(address, bytes32, bytes calldata, bytes calldata) external pure returns (bool) {
        return false;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
