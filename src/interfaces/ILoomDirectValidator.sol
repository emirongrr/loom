// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Optional validator capability for EntryPoint-independent execution.
/// @dev Implementations must validate the account-provided EIP-712 digest and
///      enforce every policy required for the canonical account call.
interface ILoomDirectValidator {
    function validateDirectExecution(
        address account,
        bytes32 executionHash,
        bytes calldata signature,
        bytes calldata accountCall
    ) external view returns (bool);
}
