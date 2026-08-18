// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {P256RecoveryValidator} from "./P256RecoveryValidator.sol";
import {P256Validator} from "./P256Validator.sol";

/// @notice Permissionlessly provisions a fresh P-256 validator for one exact recovery intent.
/// @dev The factory has no owner, upgrade path, mutable configuration, or account authority.
contract P256RecoveryValidatorFactory {
    error InvalidRecoveryValidatorInput();
    error InvalidFallbackVerifier();
    error UnexpectedValidatorAddress();
    error UnexpectedValidatorReservation();

    bytes32 public constant RECOVERY_VALIDATOR_SALT_DOMAIN = keccak256("loom.p256.recovery-validator.v1");

    address public immutable fallbackVerifier;
    bytes32 public immutable validatorInitCodeHash;

    event RecoveryValidatorDeployed(
        address indexed account, uint64 indexed recoveryNonce, bytes32 indexed initDataHash, address validator
    );

    constructor(address fallbackVerifier_) {
        if (fallbackVerifier_ != address(0) && fallbackVerifier_.code.length == 0) {
            revert InvalidFallbackVerifier();
        }
        fallbackVerifier = fallbackVerifier_;
        validatorInitCodeHash =
            keccak256(abi.encodePacked(type(P256RecoveryValidator).creationCode, abi.encode(fallbackVerifier_)));
    }

    function deploymentSalt(address account, uint64 recoveryNonce, bytes32 initDataHash) public pure returns (bytes32) {
        if (account == address(0) || initDataHash == bytes32(0)) revert InvalidRecoveryValidatorInput();
        return keccak256(abi.encode(RECOVERY_VALIDATOR_SALT_DOMAIN, account, recoveryNonce, initDataHash));
    }

    function getAddress(address account, uint64 recoveryNonce, bytes32 initDataHash) public view returns (address) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), deploymentSalt(account, recoveryNonce, initDataHash), validatorInitCodeHash
            )
        );
        return address(uint160(uint256(digest)));
    }

    /// @notice The hash of the `initialize` calldata these key fields produce.
    /// @dev Computed here rather than taken from the caller so the address, the
    /// commitment a guardian checks, and the key actually written can never
    /// describe three different things.
    function initDataHashFor(bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash, address policyHook)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodeWithSelector(P256Validator.initialize.selector, x, y, rpIdHash, originHash, policyHook)
        );
    }

    /// @notice Deploy a recovery validator and write its key in one transaction.
    /// @dev Deploying and initializing together is what lets `executeRecovery`
    /// take no initializer (ADR-0025): nothing has to survive from the device
    /// that started the recovery. Repeat calls with identical input return the
    /// existing validator.
    function deploy(
        address account,
        uint64 recoveryNonce,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        bytes32 originHash,
        address policyHook
    ) external returns (address validator) {
        bytes32 initDataHash = initDataHashFor(x, y, rpIdHash, originHash, policyHook);
        address predicted = getAddress(account, recoveryNonce, initDataHash);
        if (predicted.code.length != 0) {
            _requireReservation(predicted, account, initDataHash);
            return predicted;
        }

        P256RecoveryValidator deployed =
            new P256RecoveryValidator{salt: deploymentSalt(account, recoveryNonce, initDataHash)}(fallbackVerifier);
        validator = address(deployed);
        if (validator != predicted) revert UnexpectedValidatorAddress();
        deployed.provisionRecoveryIntent(account, initDataHash, x, y, rpIdHash, originHash, policyHook);
        _requireReservation(validator, account, initDataHash);
        emit RecoveryValidatorDeployed(account, recoveryNonce, initDataHash, validator);
    }

    function _requireReservation(address validator, address account, bytes32 initDataHash) private view {
        P256RecoveryValidator deployed = P256RecoveryValidator(validator);
        if (deployed.recoveryAccount() != account || deployed.recoveryInitDataHash() != initDataHash) {
            revert UnexpectedValidatorReservation();
        }
    }
}
