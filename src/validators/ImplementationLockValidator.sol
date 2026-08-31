// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";

/// @notice Permanently prevents the shared implementation address from acting as a wallet.
/// @dev The implementation must be initialized to close its initializer, but assigning a
///      deployer or burn-address signer would still create authority at that address. This
///      stateless validator deliberately accepts no ERC-4337 or ERC-1271 signature.
contract ImplementationLockValidator is ILoomValidator {
    function validateUserOp(address, bytes32, uint256, bytes calldata, bytes calldata, address)
        external
        pure
        returns (uint256)
    {
        return ValidationDataLib.SIG_VALIDATION_FAILED;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
