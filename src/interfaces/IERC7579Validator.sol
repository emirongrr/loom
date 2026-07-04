// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @notice Standard ERC-7579 validator module surface, as implemented by
/// third-party modules (Rhinestone, ZeroDev, Safe7579, etc.). Loom does not
/// implement this interface on its account; `ERC7579ValidatorShim` calls it on
/// a foreign module. Module type 1 (VALIDATOR) matches Loom's `ModuleType`.
interface IERC7579Validator {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 typeID) external view returns (bool);
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        returns (uint256 validationData);
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4);
}
