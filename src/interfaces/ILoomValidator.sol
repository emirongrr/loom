// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomModule} from "./ILoomModule.sol";

interface ILoomValidator is ILoomModule {
    function validateUserOp(
        address account,
        bytes32 userOpHash,
        uint256 nonce,
        bytes calldata signature,
        bytes calldata callData,
        address paymaster
    ) external returns (uint256 validationData);

    function isValidSignature(address account, bytes32 hash, bytes calldata signature) external view returns (bool);
}
