// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Canonical identities for guardian recovery and L1 keystore sync.
/// @dev The two domains intentionally remain distinct: keystore sync binds an
/// L1 identity, complete replacement set, timestamps, L1 version, and chain ID.
library RecoveryIdLib {
    function recoveryId(
        address account,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 configVersion,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                account,
                oldValidatorsHash,
                newValidator,
                initDataHash,
                newGuardianRoot,
                newGuardianThreshold,
                configVersion,
                nonce
            )
        );
    }

    function keystoreSyncId(
        address account,
        bytes32 identityId,
        bytes32 oldValidatorsHash,
        bytes32 newValidatorRoot,
        bytes32 newValidatorsHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 l1Version,
        uint48 readyAt,
        uint48 expiresAt,
        uint64 accountConfigVersion,
        uint64 nonce,
        uint256 chainId
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                account,
                identityId,
                oldValidatorsHash,
                newValidatorRoot,
                newValidatorsHash,
                newGuardianRoot,
                newGuardianThreshold,
                l1Version,
                readyAt,
                expiresAt,
                accountConfigVersion,
                nonce,
                chainId
            )
        );
    }
}
