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

    /// @dev v2 because the salt now binds the rotated guardian set (ADR-0026).
    /// A new domain keeps v1 addresses meaning exactly what they meant.
    bytes32 public constant RECOVERY_VALIDATOR_SALT_DOMAIN = keccak256("loom.p256.recovery-validator.v2");

    address public immutable fallbackVerifier;
    bytes32 public immutable validatorInitCodeHash;

    event RecoveryValidatorDeployed(
        address indexed account,
        uint64 indexed recoveryNonce,
        bytes32 indexed initDataHash,
        address validator,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    );

    constructor(address fallbackVerifier_) {
        if (fallbackVerifier_ != address(0) && fallbackVerifier_.code.length == 0) {
            revert InvalidFallbackVerifier();
        }
        fallbackVerifier = fallbackVerifier_;
        validatorInitCodeHash =
            keccak256(abi.encodePacked(type(P256RecoveryValidator).creationCode, abi.encode(fallbackVerifier_)));
    }

    /// @notice The salt this intent deploys under.
    /// @dev The rotated guardian set is part of it, and that is load-bearing.
    /// Publication is permissionless and an intent can only be provisioned once
    /// per address, so a root left outside the salt would let anyone deploy the
    /// address first with a set of their choosing and occupy it for good. Inside
    /// the salt, a different set is simply a different address.
    function deploymentSalt(
        address account,
        uint64 recoveryNonce,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) public pure returns (bytes32) {
        if (account == address(0) || initDataHash == bytes32(0)) {
            revert InvalidRecoveryValidatorInput();
        }
        if (newGuardianRoot == bytes32(0) || newGuardianThreshold == 0) revert InvalidRecoveryValidatorInput();
        return keccak256(
            abi.encode(
                RECOVERY_VALIDATOR_SALT_DOMAIN,
                account,
                recoveryNonce,
                initDataHash,
                newGuardianRoot,
                newGuardianThreshold
            )
        );
    }

    function getAddress(
        address account,
        uint64 recoveryNonce,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) public view returns (address) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                deploymentSalt(account, recoveryNonce, initDataHash, newGuardianRoot, newGuardianThreshold),
                validatorInitCodeHash
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
    /// existing validator. `recoveryNonce` is a deterministic-address namespace,
    /// not factory authority: callers use the target manager's live nonce, while
    /// guardians authorize the resulting validator address in that manager's
    /// nonce-bound proposal digest. The ownerless factory deliberately calls no
    /// manager and cannot decide which recovery module an account trusts.
    function deploy(
        address account,
        uint64 recoveryNonce,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        bytes32 originHash,
        address policyHook,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external returns (address validator) {
        bytes32 initDataHash = initDataHashFor(x, y, rpIdHash, originHash, policyHook);
        address predicted = getAddress(account, recoveryNonce, initDataHash, newGuardianRoot, newGuardianThreshold);
        if (predicted.code.length != 0) {
            _requireReservation(predicted, account, initDataHash, newGuardianRoot, newGuardianThreshold);
            return predicted;
        }

        P256RecoveryValidator deployed = new P256RecoveryValidator{
            salt: deploymentSalt(account, recoveryNonce, initDataHash, newGuardianRoot, newGuardianThreshold)
        }(
            fallbackVerifier
        );
        validator = address(deployed);
        if (validator != predicted) revert UnexpectedValidatorAddress();
        deployed.provisionRecoveryIntent(
            account, initDataHash, x, y, rpIdHash, originHash, policyHook, newGuardianRoot, newGuardianThreshold
        );
        emit RecoveryValidatorDeployed(
            account, recoveryNonce, initDataHash, validator, newGuardianRoot, newGuardianThreshold
        );
    }

    function _requireReservation(
        address validator,
        address account,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) private view {
        P256RecoveryValidator deployed = P256RecoveryValidator(validator);
        if (deployed.recoveryAccount() != account || deployed.recoveryInitDataHash() != initDataHash) {
            revert UnexpectedValidatorReservation();
        }
        // The address already commits to these, so a mismatch means the code at
        // that address is not the child this factory believes it deployed.
        if (
            deployed.recoveryGuardianRoot() != newGuardianRoot
                || deployed.recoveryGuardianThreshold() != newGuardianThreshold
        ) {
            revert UnexpectedValidatorReservation();
        }
    }
}
