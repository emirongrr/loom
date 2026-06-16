// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface ILoomKeystore {
    struct KeystoreConfig {
        bytes32 validatorRoot;
        bytes32 guardianRoot;
        bytes32 appAccountRoot;
        uint8 guardianThreshold;
        uint64 version;
    }

    function controllerOf(bytes32 identityId) external view returns (address);
    function getConfig(bytes32 identityId) external view returns (KeystoreConfig memory);
}
