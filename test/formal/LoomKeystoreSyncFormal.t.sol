// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomKeystore} from "../../src/keystore/LoomKeystore.sol";
import {KeystoreSyncRecoveryModule} from "../../src/recovery/KeystoreSyncRecoveryModule.sol";
import {ILoomAccount} from "../../src/interfaces/ILoomAccount.sol";
import {ILoomKeystore} from "../../src/interfaces/ILoomKeystore.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {MockKeystoreProofVerifier} from "../mocks/MockKeystoreProofVerifier.sol";
import {FormalAccountBase, FormalGuardianVerifier} from "./FormalHelpers.sol";

contract LoomKeystoreSyncFormal is FormalAccountBase {
    bytes32 internal constant IDENTITY_ID = keccak256("formal.identity");
    bytes32 internal constant NEW_GUARDIAN_ROOT = keccak256("formal-new-guardian-root");

    function _pendingSync(KeystoreSyncRecoveryModule sync, address account)
        internal
        view
        returns (KeystoreSyncRecoveryModule.PendingSync memory pending)
    {
        (
            pending.identityId,
            pending.oldValidatorsHash,
            pending.newValidatorRoot,
            pending.newValidatorsHash,
            pending.newGuardianRoot,
            pending.newGuardianThreshold,
            pending.l1Version,
            pending.readyAt,
            pending.expiresAt,
            pending.accountConfigVersion,
            pending.nonce
        ) = sync.pendingSyncs(account);
    }

    function _assertPendingSyncUnchanged(
        KeystoreSyncRecoveryModule sync,
        address account,
        KeystoreSyncRecoveryModule.PendingSync memory expected
    ) internal view {
        KeystoreSyncRecoveryModule.PendingSync memory actual = _pendingSync(sync, account);
        assert(actual.identityId == expected.identityId);
        assert(actual.oldValidatorsHash == expected.oldValidatorsHash);
        assert(actual.newValidatorRoot == expected.newValidatorRoot);
        assert(actual.newValidatorsHash == expected.newValidatorsHash);
        assert(actual.newGuardianRoot == expected.newGuardianRoot);
        assert(actual.newGuardianThreshold == expected.newGuardianThreshold);
        assert(actual.l1Version == expected.l1Version);
        assert(actual.readyAt == expected.readyAt);
        assert(actual.expiresAt == expected.expiresAt);
        assert(actual.accountConfigVersion == expected.accountConfigVersion);
        assert(actual.nonce == expected.nonce);
    }

    function _assertRevert(bytes memory revertData, bytes4 expectedSelector) internal pure {
        assert(keccak256(revertData) == keccak256(abi.encodeWithSelector(expectedSelector)));
    }

    function _assertConfigEquals(
        ILoomKeystore.KeystoreConfig memory actual,
        ILoomKeystore.KeystoreConfig memory expected
    ) internal pure {
        assert(actual.validatorRoot == expected.validatorRoot);
        assert(actual.guardianRoot == expected.guardianRoot);
        assert(actual.appAccountRoot == expected.appAccountRoot);
        assert(actual.guardianThreshold == expected.guardianThreshold);
        assert(actual.version == expected.version);
    }

    function testFuzz_KeystoreUpdateRequiresController(address caller) public {
        check_KeystoreUpdateRequiresController(caller);
    }

    function check_KeystoreUpdateRequiresController(address caller) public {
        LoomKeystore keystore = new LoomKeystore();
        bytes32 validatorRoot = keccak256("formal-validator-root");
        bytes32 appRoot = keccak256("formal-app-root");
        keystore.register(IDENTITY_ID, address(this), validatorRoot, keccak256("formal-guardian-root"), appRoot, 1);
        if (caller == address(this)) return;
        ILoomKeystore.KeystoreConfig memory configBefore = keystore.getConfig(IDENTITY_ID);
        address controllerBefore = keystore.controllerOf(IDENTITY_ID);
        bytes32 configHashBefore = keystore.configHash(IDENTITY_ID);

        vm.prank(caller);
        (bool ok, bytes memory revertData) = address(keystore)
            .call(
                abi.encodeCall(
                    LoomKeystore.updateConfig, (IDENTITY_ID, validatorRoot, keccak256("attacker-root"), appRoot, 1)
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomKeystore.Unauthorized.selector);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);
        _assertConfigEquals(config, configBefore);
        assert(keystore.controllerOf(IDENTITY_ID) == controllerBefore);
        assert(keystore.configHash(IDENTITY_ID) == configHashBefore);
    }

    function testFuzz_SyncDelayIsEnforced(uint256 seed) public {
        check_SyncDelayIsEnforced(seed);
    }

    function check_SyncDelayIsEnforced(uint256 seed) public {
        seed;
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync(keccak256("formal-guardians"), 1);
        MockValidator newValidator = new MockValidator();
        _registerConfig(keystore, sync, address(account), newValidator);
        _propose(sync, keystore, account, oldValidator, newValidator);
        KeystoreSyncRecoveryModule.PendingSync memory pendingBefore = _pendingSync(sync, address(account));
        uint64 syncNonceBefore = sync.syncNonces(address(account));
        uint64 lastAppliedBefore = sync.lastAppliedL1Version(address(account));
        bytes32 configHashBefore = account.configHash();
        uint64 configVersionBefore = account.configVersion();
        bytes32 guardianRootBefore = account.guardianRoot();
        uint8 guardianThresholdBefore = account.guardianThreshold();

        (bool ok, bytes memory revertData) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), _old(oldValidator), _newValidators(newValidator))
                )
            );

        assert(!ok);
        _assertRevert(revertData, KeystoreSyncRecoveryModule.SyncNotReady.selector);
        _assertPendingSyncUnchanged(sync, address(account), pendingBefore);
        assert(sync.syncNonces(address(account)) == syncNonceBefore);
        assert(sync.lastAppliedL1Version(address(account)) == lastAppliedBefore);
        assert(account.configHash() == configHashBefore);
        assert(account.configVersion() == configVersionBefore);
        assert(account.guardianRoot() == guardianRootBefore);
        assert(account.guardianThreshold() == guardianThresholdBefore);
        assert(account.validatorCount() == 1);
        assert(account.validatorAt(0) == address(oldValidator));
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function testFuzz_GuardianCancellationGrantsNoValidatorAuthority(uint256 seed) public {
        check_GuardianCancellationGrantsNoValidatorAuthority(seed);
    }

    function check_GuardianCancellationGrantsNoValidatorAuthority(uint256 seed) public {
        seed;
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("sync-guardian-key");
        bytes32 salt = keccak256("sync-guardian-salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);

        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync(leaf, 1);
        MockValidator newValidator = new MockValidator();
        _registerConfig(keystore, sync, address(account), newValidator);
        _propose(sync, keystore, account, oldValidator, newValidator);

        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        sync.cancelSyncWithGuardians(address(account), approvals);

        (,,,,,,, uint48 readyAt,,,) = sync.pendingSyncs(address(account));
        assert(readyAt == 0);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
        assert(account.guardianRoot() == leaf);
    }

    function _accountWithSync(bytes32 guardianLeaf, uint8 threshold)
        internal
        returns (
            LoomAccount account,
            KeystoreSyncRecoveryModule sync,
            LoomKeystore keystore,
            MockValidator oldValidator
        )
    {
        keystore = new LoomKeystore();
        MockKeystoreProofVerifier verifier = new MockKeystoreProofVerifier();
        sync = new KeystoreSyncRecoveryModule(address(keystore), verifier);
        oldValidator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(sync), "");
        account = new LoomAccount(
            _entryPointAddress(),
            guardianLeaf,
            threshold,
            keccak256(abi.encode("formal-keystore-sync-config", address(oldValidator), address(sync))),
            modules
        );
    }

    function _registerConfig(
        LoomKeystore keystore,
        KeystoreSyncRecoveryModule sync,
        address account,
        MockValidator newValidator
    ) internal {
        ILoomAccount.RecoveryModuleInit[] memory validators = _newValidators(newValidator);
        keystore.register(
            IDENTITY_ID,
            address(this),
            sync.validatorSetRoot(validators),
            NEW_GUARDIAN_ROOT,
            sync.appAccountLeaf(account),
            1
        );
    }

    function _propose(
        KeystoreSyncRecoveryModule sync,
        LoomKeystore keystore,
        LoomAccount account,
        MockValidator oldValidator,
        MockValidator newValidator
    ) internal returns (bytes32 syncId) {
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);
        syncId = sync.proposeSync(
            address(account),
            IDENTITY_ID,
            config,
            "",
            new bytes32[](0),
            _old(oldValidator),
            _newValidators(newValidator)
        );
    }

    function _newValidators(MockValidator newValidator)
        internal
        pure
        returns (ILoomAccount.RecoveryModuleInit[] memory validators)
    {
        validators = new ILoomAccount.RecoveryModuleInit[](1);
        validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(newValidator), "");
    }

    function _old(MockValidator oldValidator) internal pure returns (address[] memory validators) {
        validators = new address[](1);
        validators[0] = address(oldValidator);
    }
}
