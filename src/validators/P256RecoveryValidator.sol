// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "./P256Validator.sol";

/// @notice A P-256 validator reserved for one exact account recovery intent.
/// @dev The factory reserves the account and initializer atomically with CREATE2 deployment.
contract P256RecoveryValidator is P256Validator {
    error UnauthorizedRecoveryReservation();
    error RecoveryIntentAlreadyReserved();
    error InvalidRecoveryIntent();
    error InvalidRecoveryInitializer();

    address public immutable recoveryValidatorFactory;
    address public recoveryAccount;
    bytes32 public recoveryInitDataHash;

    constructor(address fallbackVerifier_) P256Validator(fallbackVerifier_) {
        recoveryValidatorFactory = msg.sender;
    }

    function reserveRecoveryIntent(address account, bytes32 initDataHash) external {
        if (msg.sender != recoveryValidatorFactory) revert UnauthorizedRecoveryReservation();
        if (recoveryAccount != address(0)) revert RecoveryIntentAlreadyReserved();
        if (account == address(0) || initDataHash == bytes32(0)) revert InvalidRecoveryIntent();
        recoveryAccount = account;
        recoveryInitDataHash = initDataHash;
    }

    function initialize(bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash, address policyHook)
        external
        override
    {
        address account = recoveryAccount;
        if (msg.sender != account || account == address(0) || keccak256(msg.data) != recoveryInitDataHash) {
            revert InvalidRecoveryInitializer();
        }

        // A compromised current validator may submit the exact committed
        // initializer early. Treating that repeat as success preserves delayed
        // guardian recovery without granting any choice over the new key.
        PublicKey memory existing = publicKeys[account];
        if (existing.x != bytes32(0)) {
            if (
                existing.x != x || existing.y != y || existing.rpIdHash != rpIdHash || existing.originHash != originHash
                    || policyHooks[account] != policyHook
            ) revert InvalidRecoveryInitializer();
            return;
        }
        if (policyHook == address(0)) revert InvalidPolicyHook();
        _setKey(account, x, y, rpIdHash, originHash);
        policyHooks[account] = policyHook;
        emit PolicyHookSet(account, policyHook);
    }
}
