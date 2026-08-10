// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";
import {GuardianVerificationLib} from "../libraries/GuardianVerificationLib.sol";

/// @notice L1 keystore of per-identity configuration (validator/guardian/app-account
/// roots, guardian threshold, version). It has no Loom administrator, bridge
/// operator, relayer role, or upgrade authority.
///
/// Each identity's `controller` is its sole authority: it is the only party that
/// can `updateConfig` or offer the identity to a new controller, and config
/// changes are read cross-chain by `KeystoreSyncRecoveryModule`. Control moves
/// only through a two-step handshake - the current controller offers with
/// `transferController` and the recipient claims with `acceptController` - so a
/// mistyped or unusable address cannot strand an identity. The controller
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
    // Appended after `_configs` on purpose: `OPStackL2KeystoreVerifier` proves
    // `controllerOf` at slot 0 and `_configs` at slot 1, and a storage-layout
    // pin test in test/unit/OPStackL2KeystoreVerifier.t.sol asserts both.
    mapping(bytes32 identityId => address pendingController) public pendingControllerOf;

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
    event ControllerTransferProposed(
        bytes32 indexed identityId, address indexed controller, address indexed proposedController
    );
    event ControllerTransferCancelled(bytes32 indexed identityId, address indexed proposedController);
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

    /// @notice Offers control of `identityId` to `newController`. Control does
    /// not move until that address calls `acceptController`.
    /// @dev The handshake exists because this contract has no administrator and
    /// no recovery path: a single-step transfer to a mistyped address, a
    /// contract that cannot call this keystore, or an address the user controls
    /// on a different chain would strand the identity permanently, with no way
    /// to update its config or reclaim it. Requiring the recipient to act
    /// proves it can. A pending offer grants nothing: the current controller
    /// keeps full authority and can re-target or cancel the offer until it is
    /// accepted.
    ///
    /// There is deliberately no delay on top of the handshake. A delay would
    /// only matter against an already-compromised controller, and that
    /// attacker can rewrite the identity's config through `updateConfig`
    /// immediately regardless, so the delay would buy protection the rest of
    /// the surface does not provide. Controller safety comes from the choice of
    /// controller (see the contract notice), not from a timer here.
    function transferController(bytes32 identityId, address newController) external {
        _requireController(identityId);
        if (newController == address(0) || newController == controllerOf[identityId]) revert InvalidController();
        pendingControllerOf[identityId] = newController;
        emit ControllerTransferProposed(identityId, msg.sender, newController);
    }

    /// @notice Completes a transfer offered by the current controller. Only the
    /// exact offered address can call this.
    function acceptController(bytes32 identityId) external {
        address newController = pendingControllerOf[identityId];
        if (newController == address(0) || msg.sender != newController) revert Unauthorized();
        address oldController = controllerOf[identityId];
        controllerOf[identityId] = newController;
        delete pendingControllerOf[identityId];
        emit ControllerTransferred(identityId, oldController, newController);
    }

    /// @notice Withdraws an outstanding transfer offer.
    function cancelControllerTransfer(bytes32 identityId) external {
        _requireController(identityId);
        address newController = pendingControllerOf[identityId];
        if (newController == address(0)) revert InvalidController();
        delete pendingControllerOf[identityId];
        emit ControllerTransferCancelled(identityId, newController);
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
