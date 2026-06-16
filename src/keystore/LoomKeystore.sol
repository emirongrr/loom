// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";

contract LoomKeystore is ILoomKeystore {
    error InvalidIdentity();
    error InvalidController();
    error InvalidConfig();
    error IdentityAlreadyRegistered();
    error IdentityNotRegistered();
    error Unauthorized();

    uint8 public constant MAX_GUARDIAN_THRESHOLD = 32;

    mapping(bytes32 identityId => address controller) public controllerOf;
    mapping(bytes32 identityId => KeystoreConfig config) private _configs;

    event IdentityRegistered(
        bytes32 indexed identityId,
        address indexed controller,
        bytes32 indexed validatorRoot,
        bytes32 guardianRoot,
        bytes32 appAccountRoot,
        uint8 guardianThreshold,
        uint64 version
    );
    event ConfigUpdated(
        bytes32 indexed identityId,
        bytes32 indexed validatorRoot,
        bytes32 guardianRoot,
        bytes32 appAccountRoot,
        uint8 guardianThreshold,
        uint64 version
    );
    event ControllerTransferred(
        bytes32 indexed identityId, address indexed oldController, address indexed newController
    );

    function register(
        bytes32 identityId,
        address controller,
        bytes32 validatorRoot,
        bytes32 guardianRoot,
        bytes32 appAccountRoot,
        uint8 guardianThreshold
    ) external {
        if (identityId == bytes32(0)) revert InvalidIdentity();
        if (controller == address(0)) revert InvalidController();
        if (msg.sender != controller) revert Unauthorized();
        if (controllerOf[identityId] != address(0)) revert IdentityAlreadyRegistered();
        _validateConfig(validatorRoot, guardianRoot, appAccountRoot, guardianThreshold);

        controllerOf[identityId] = controller;
        _configs[identityId] = KeystoreConfig({
            validatorRoot: validatorRoot,
            guardianRoot: guardianRoot,
            appAccountRoot: appAccountRoot,
            guardianThreshold: guardianThreshold,
            version: 1
        });
        emit IdentityRegistered(
            identityId, controller, validatorRoot, guardianRoot, appAccountRoot, guardianThreshold, 1
        );
    }

    function updateConfig(
        bytes32 identityId,
        bytes32 validatorRoot,
        bytes32 guardianRoot,
        bytes32 appAccountRoot,
        uint8 guardianThreshold
    ) external {
        _requireController(identityId);
        _validateConfig(validatorRoot, guardianRoot, appAccountRoot, guardianThreshold);

        KeystoreConfig storage config = _configs[identityId];
        uint64 nextVersion = config.version + 1;
        config.validatorRoot = validatorRoot;
        config.guardianRoot = guardianRoot;
        config.appAccountRoot = appAccountRoot;
        config.guardianThreshold = guardianThreshold;
        config.version = nextVersion;
        emit ConfigUpdated(identityId, validatorRoot, guardianRoot, appAccountRoot, guardianThreshold, nextVersion);
    }

    function transferController(bytes32 identityId, address newController) external {
        _requireController(identityId);
        if (newController == address(0)) revert InvalidController();
        address oldController = controllerOf[identityId];
        controllerOf[identityId] = newController;
        emit ControllerTransferred(identityId, oldController, newController);
    }

    function getConfig(bytes32 identityId) external view returns (KeystoreConfig memory) {
        if (controllerOf[identityId] == address(0)) revert IdentityNotRegistered();
        return _configs[identityId];
    }

    function configHash(bytes32 identityId) external view returns (bytes32) {
        if (controllerOf[identityId] == address(0)) revert IdentityNotRegistered();
        return keccak256(abi.encode(_configs[identityId]));
    }

    function _requireController(bytes32 identityId) internal view {
        address controller = controllerOf[identityId];
        if (controller == address(0)) revert IdentityNotRegistered();
        if (msg.sender != controller) revert Unauthorized();
    }

    function _validateConfig(
        bytes32 validatorRoot,
        bytes32 guardianRoot,
        bytes32 appAccountRoot,
        uint8 guardianThreshold
    ) internal pure {
        if (
            validatorRoot == bytes32(0) || guardianRoot == bytes32(0) || appAccountRoot == bytes32(0)
                || guardianThreshold == 0 || guardianThreshold > MAX_GUARDIAN_THRESHOLD
        ) revert InvalidConfig();
    }
}
