// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "./P256Validator.sol";

/// @notice Permissionlessly provisions a fresh P-256 validator for one exact recovery intent.
/// @dev The factory has no owner, upgrade path, mutable configuration, or account authority.
contract P256RecoveryValidatorFactory {
    error InvalidRecoveryValidatorInput();
    error InvalidFallbackVerifier();
    error UnexpectedValidatorAddress();

    bytes32 public constant RECOVERY_VALIDATOR_SALT_DOMAIN = keccak256("loom.p256.recovery-validator.v1");

    address public immutable fallbackVerifier;
    bytes32 public immutable validatorInitCodeHash;

    event RecoveryValidatorDeployed(
        address indexed account,
        uint64 indexed recoveryNonce,
        bytes32 indexed initDataHash,
        address validator
    );

    constructor(address fallbackVerifier_) {
        if (fallbackVerifier_ != address(0) && fallbackVerifier_.code.length == 0) {
            revert InvalidFallbackVerifier();
        }
        fallbackVerifier = fallbackVerifier_;
        validatorInitCodeHash = keccak256(
            abi.encodePacked(type(P256Validator).creationCode, abi.encode(fallbackVerifier_))
        );
    }

    function deploymentSalt(address account, uint64 recoveryNonce, bytes32 initDataHash)
        public
        pure
        returns (bytes32)
    {
        if (account == address(0) || initDataHash == bytes32(0)) revert InvalidRecoveryValidatorInput();
        return keccak256(abi.encode(RECOVERY_VALIDATOR_SALT_DOMAIN, account, recoveryNonce, initDataHash));
    }

    function getAddress(address account, uint64 recoveryNonce, bytes32 initDataHash)
        public
        view
        returns (address)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), deploymentSalt(account, recoveryNonce, initDataHash), validatorInitCodeHash)
        );
        return address(uint160(uint256(digest)));
    }

    function deploy(address account, uint64 recoveryNonce, bytes32 initDataHash) external returns (address validator) {
        address predicted = getAddress(account, recoveryNonce, initDataHash);
        if (predicted.code.length != 0) return predicted;

        validator = address(new P256Validator{salt: deploymentSalt(account, recoveryNonce, initDataHash)}(fallbackVerifier));
        if (validator != predicted) revert UnexpectedValidatorAddress();
        emit RecoveryValidatorDeployed(account, recoveryNonce, initDataHash, validator);
    }
}
