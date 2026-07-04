// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";
import {GuardianVerificationLib} from "../libraries/GuardianVerificationLib.sol";

/// @notice L1 keystore of per-identity configuration (validator/guardian/app-account
/// roots, guardian threshold, version). It has no Loom administrator, bridge
/// operator, relayer role, or upgrade authority.
///
/// Each identity's `controller` is its sole authority: it is the only party that
/// can `updateConfig` or `transferController` for that identity, and config
/// changes are read cross-chain by `KeystoreSyncRecoveryModule`. The controller
/// is therefore security-critical. The recommended controller is the user's own
/// L1 Loom account (or another user-controlled account with its own recovery and
/// delay model), NOT a bare hot EOA: a compromised controller can rewrite the
/// keystore config and, after the L1 version advances, drive an L2 keystore sync.
/// This is a deployment convention, not a contract-enforced restriction — the
/// contract intentionally accepts any non-zero controller to preserve
/// permissionless use. See docs/design/keystore.md.
contract LoomKeystore is ILoomKeystore {
    error InvalidIdentity();
    error InvalidController();
    error InvalidConfig();
    error IdentityAlreadyRegistered();
    error IdentityNotRegistered();
    error Unauthorized();

    uint8 public constant MAX_GUARDIAN_THRESHOLD = GuardianVerificationLib.MAX_GUARDIAN_THRESHOLD;

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

    /// @notice Registers a new identity. The caller must be the `controller`.
    /// @param controller Sole authority over this identity (see contract notice):
    /// it alone can later `updateConfig` or `transferController`. Use a
    /// user-controlled account with its own recovery and delay model rather than a
    /// bare hot EOA; this is a convention, not enforced here.
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
