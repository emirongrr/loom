// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../../src/interfaces/ILoomValidator.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";

contract PaymasterAwareValidator is ILoomValidator {
    address public immutable expectedPaymaster;

    constructor(address expectedPaymaster_) {
        expectedPaymaster = expectedPaymaster_;
    }

    function validateUserOp(address, bytes32, uint256, bytes calldata, bytes calldata, address paymaster)
        external
        view
        returns (uint256)
    {
        return paymaster == expectedPaymaster ? 0 : ValidationDataLib.SIG_VALIDATION_FAILED;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
