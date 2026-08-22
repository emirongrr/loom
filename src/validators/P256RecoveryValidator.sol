// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {P256Validator} from "./P256Validator.sol";

/// @notice A P-256 validator provisioned for one exact account recovery intent.
/// @dev The factory writes the account, the committed initializer, and the key
/// itself in the transaction that deploys this contract (ADR-0025). Nothing has
/// to be supplied again when the recovery executes, so a recovery does not
/// depend on the device that started it still existing.
contract P256RecoveryValidator is P256Validator {
    error UnauthorizedRecoveryReservation();
    error RecoveryIntentAlreadyReserved();
    error InvalidRecoveryIntent();
    error RecoveryValidatorAlreadyInitialized();

    /// @dev Mirrors `GuardianVerificationLib.MAX_GUARDIAN_THRESHOLD`. Duplicated
    /// rather than imported so this validator carries no dependency on the
    /// manager's libraries; the deployment gate checks the two agree.
    uint8 internal constant MAX_RECOVERY_GUARDIAN_THRESHOLD = 32;

    address public immutable recoveryValidatorFactory;
    address public recoveryAccount;
    bytes32 public recoveryInitDataHash;
    /// @notice The guardian set this recovery rotates to, fixed when it is published.
    /// @dev Recorded so any device can rebuild the proposal from the chain
    /// alone (ADR-0026). The deployment salt binds both, so the address is the
    /// commitment: a different set is a different validator.
    bytes32 public recoveryGuardianRoot;
    uint8 public recoveryGuardianThreshold;

    constructor(address fallbackVerifier_) P256Validator(fallbackVerifier_) {
        recoveryValidatorFactory = msg.sender;
    }

    /// @notice Reserve this validator for one account and write its key.
    /// @dev `initDataHash` is the hash of the `initialize` calldata these fields
    /// produce. The factory derives the deployment salt from it, so the address
    /// commits to exactly this key and a guardian can still check the address
    /// against the hash in the request they are approving.
    function provisionRecoveryIntent(
        address account,
        bytes32 initDataHash,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        bytes32 originHash,
        address policyHook,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external {
        if (msg.sender != recoveryValidatorFactory) revert UnauthorizedRecoveryReservation();
        if (recoveryAccount != address(0)) revert RecoveryIntentAlreadyReserved();
        if (account == address(0) || initDataHash == bytes32(0)) revert InvalidRecoveryIntent();
        if (policyHook == address(0)) revert InvalidPolicyHook();
        // A rotation nobody could satisfy is not worth committing to: a zero
        // root has no members, and a threshold of zero would let a recovered
        // account be recovered again by no one at all.
        if (newGuardianRoot == bytes32(0)) revert InvalidRecoveryIntent();
        if (newGuardianThreshold == 0 || newGuardianThreshold > MAX_RECOVERY_GUARDIAN_THRESHOLD) {
            revert InvalidRecoveryIntent();
        }
        recoveryAccount = account;
        recoveryInitDataHash = initDataHash;
        recoveryGuardianRoot = newGuardianRoot;
        recoveryGuardianThreshold = newGuardianThreshold;
        _setKey(account, x, y, rpIdHash, originHash);
        policyHooks[account] = policyHook;
        emit PolicyHookSet(account, policyHook);
    }

    /// @notice Always reverts: this validator is initialized when it is deployed.
    /// @dev Recovery installs it with empty init data, so the account never calls
    /// this. Leaving it open would be a second way to write a key that no
    /// guardian approved, since the address only commits to the first one.
    function initialize(bytes32, bytes32, bytes32, bytes32, address) external pure override {
        revert RecoveryValidatorAlreadyInitialized();
    }
}
