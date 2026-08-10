// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ILoomValidator} from "../../src/interfaces/ILoomValidator.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

/// @notice A validator that reverts instead of answering.
/// @dev It proves nothing about signatures. It exists so a test can reach the
/// account's `try`/`catch` around the validator call and assert the account
/// fails closed rather than letting the revert bubble out of validation - the
/// behaviour recorded as MEDIUM-04 in
/// `docs/reviews/preliminary-review-disposition.md`.
///
/// A validator that returns `SIG_VALIDATION_FAILED` would not exercise the same
/// path: the point is the account's handling of a module that does not return
/// at all. See docs/security/test-doubles.md.
contract RevertingValidator is ILoomValidator {
    error ValidatorUnavailable();

    function validateUserOp(address, bytes32, uint256, bytes calldata, bytes calldata, address)
        external
        pure
        returns (uint256)
    {
        revert ValidatorUnavailable();
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        revert ValidatorUnavailable();
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
