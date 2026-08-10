// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface ILoomKeystore {
    struct KeystoreConfig {
        bytes32 validatorRoot;
        bytes32 guardianRoot;
        bytes32 appAccountRoot;
        uint8 guardianThreshold;
        uint64 version;
    }

    function controllerOf(bytes32 identityId) external view returns (address);
    /// @notice Address that has been offered control of `identityId` but has
    /// not accepted it yet. Zero when no transfer is outstanding. Control does
    /// not move until this address calls `acceptController`.
    function pendingControllerOf(bytes32 identityId) external view returns (address);
    function getConfig(bytes32 identityId) external view returns (KeystoreConfig memory);
}
