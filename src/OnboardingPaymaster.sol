// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "./libraries/ECDSA.sol";

/// @notice Bounded, signed ERC-4337 sponsorship for first-time Loom activation.
/// @dev Sponsorship authority can pay gas but has no account authority. The
/// EntryPoint charges the paymaster deposit atomically with the UserOperation,
/// so a failed activation cannot strand a prefund in the prospective account.
contract OnboardingPaymaster is BasePaymaster {
    error InvalidSponsorship();

    address public immutable factory;
    address public immutable authorizer;
    bytes32 public immutable policyHash;
    uint256 public immutable maximumCost;

    constructor(
        IEntryPoint entryPoint_,
        address factory_,
        address authorizer_,
        bytes32 policyHash_,
        uint256 maximumCost_
    ) BasePaymaster(entryPoint_, msg.sender) {
        if (factory_.code.length == 0 || authorizer_ == address(0) || policyHash_ == bytes32(0) || maximumCost_ == 0) revert InvalidSponsorship();
        factory = factory_;
        authorizer = authorizer_;
        policyHash = policyHash_;
        maximumCost = maximumCost_;
    }

    function authorizationHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter,
        uint256 costLimit
    ) public view returns (bytes32) {
        if (userOp.paymasterAndData.length < 52) revert InvalidSponsorship();
        bytes32 userOpCommitment = keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees,
                keccak256(userOp.paymasterAndData[:52])
            )
        );
        return keccak256(
            abi.encode(block.chainid, address(this), userOpCommitment, validUntil, validAfter, costLimit, policyHash)
        );
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (
            userOp.nonce != 0 || userOp.callData.length != 0 || userOp.initCode.length <= 20
                || address(bytes20(userOp.initCode[:20])) != factory
        ) revert InvalidSponsorship();
        bytes calldata data = userOp.paymasterAndData[52:];
        (uint48 validUntil, uint48 validAfter, uint256 costLimit, bytes32 suppliedPolicyHash, bytes memory signature) =
            abi.decode(data, (uint48, uint48, uint256, bytes32, bytes));
        if (suppliedPolicyHash != policyHash || costLimit > maximumCost || maxCost > costLimit) {
            revert InvalidSponsorship();
        }
        bool signatureFailed =
            ECDSA.recover(authorizationHash(userOp, validUntil, validAfter, costLimit), signature) != authorizer;
        return ("", _packValidationData(signatureFailed, validUntil, validAfter));
    }
}
