// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {LoomKeystore} from "../src/keystore/LoomKeystore.sol";
import {KeystoreSyncRecoveryModule} from "../src/recovery/KeystoreSyncRecoveryModule.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {ILoomKeystore} from "../src/interfaces/ILoomKeystore.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockKeystoreProofVerifier} from "./mocks/MockKeystoreProofVerifier.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

interface VmKeystore {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract KeystoreSyncTest {
    VmKeystore internal constant vm = VmKeystore(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant SECOND_GUARDIAN_KEY = 0xB0B;
    bytes32 internal constant IDENTITY_ID = keccak256("loom.identity.alice");
    bytes32 internal constant NEW_GUARDIAN_ROOT = keccak256("new guardian root");

    ECDSAGuardianVerifier internal guardianVerifier = new ECDSAGuardianVerifier();

    function testL1KeystoreRegistersAndUpdatesOnlyByController() public {
        LoomKeystore keystore = new LoomKeystore();
        bytes32 validatorRoot = keccak256("validator root");
        bytes32 appRoot = keccak256("app root");

        (bool rejectedBadController,) = address(keystore)
            .call(
                abi.encodeCall(
                    LoomKeystore.register,
                    (keccak256("bad"), address(0xBEEF), validatorRoot, NEW_GUARDIAN_ROOT, appRoot, 2)
                )
            );
        require(!rejectedBadController, "non-controller registered identity");

        (bool rejectedBadConfig,) = address(keystore)
            .call(
                abi.encodeCall(
                    LoomKeystore.register,
                    (keccak256("bad config"), address(this), bytes32(0), NEW_GUARDIAN_ROOT, appRoot, 2)
                )
            );
        require(!rejectedBadConfig, "invalid config registered");

        keystore.register(IDENTITY_ID, address(this), validatorRoot, NEW_GUARDIAN_ROOT, appRoot, 2);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);
        require(config.validatorRoot == validatorRoot, "validator root not stored");
        require(config.guardianRoot == NEW_GUARDIAN_ROOT, "guardian root not stored");
        require(config.appAccountRoot == appRoot, "app root not stored");
        require(config.guardianThreshold == 2, "threshold not stored");
        require(config.version == 1, "wrong initial version");

        (bool rejectedDuplicate,) = address(keystore)
            .call(
                abi.encodeCall(
                    LoomKeystore.register, (IDENTITY_ID, address(this), validatorRoot, NEW_GUARDIAN_ROOT, appRoot, 2)
                )
            );
        require(!rejectedDuplicate, "duplicate identity registered");

        (bool unauthorized,) =
            address(keystore).call(abi.encodeCall(LoomKeystore.transferController, (IDENTITY_ID, address(0xBEEF))));
        require(unauthorized, "self controller transfer should succeed");
        require(keystore.controllerOf(IDENTITY_ID) == address(0xBEEF), "controller not transferred");

        (bool rejectedOldController,) = address(keystore)
            .call(
                abi.encodeCall(
                    LoomKeystore.updateConfig, (IDENTITY_ID, keccak256("next"), NEW_GUARDIAN_ROOT, appRoot, 2)
                )
            );
        require(!rejectedOldController, "old controller updated config");
    }

    function testL1KeystoreRejectsMissingIdentityAndInvalidUpdates() public {
        LoomKeystore keystore = new LoomKeystore();
        (bool rejectedMissing,) = address(keystore).call(abi.encodeCall(LoomKeystore.getConfig, (IDENTITY_ID)));
        require(!rejectedMissing, "missing identity returned config");

        bytes32 validatorRoot = keccak256("validator root");
        bytes32 appRoot = keccak256("app root");
        keystore.register(IDENTITY_ID, address(this), validatorRoot, NEW_GUARDIAN_ROOT, appRoot, 2);

        (bool rejectedZeroController,) =
            address(keystore).call(abi.encodeCall(LoomKeystore.transferController, (IDENTITY_ID, address(0))));
        require(!rejectedZeroController, "zero controller accepted");

        (bool rejectedInvalidUpdate,) = address(keystore)
            .call(abi.encodeCall(LoomKeystore.updateConfig, (IDENTITY_ID, validatorRoot, bytes32(0), appRoot, 2)));
        require(!rejectedInvalidUpdate, "invalid update accepted");

        keystore.updateConfig(IDENTITY_ID, keccak256("next validator"), NEW_GUARDIAN_ROOT, appRoot, 2);
        ILoomKeystore.KeystoreConfig memory updated = keystore.getConfig(IDENTITY_ID);
        require(updated.version == 2, "version did not advance");
    }

    function testKeystoreSyncAppliesL1RootAfterDelay() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";

        _registerConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 1);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);

        (bool early,) = address(sync)
            .call(
                abi.encodeCall(KeystoreSyncRecoveryModule.executeSync, (address(account), _old(oldValidator), initData))
            );
        require(!early, "sync executed before delay");

        vm.warp(block.timestamp + sync.SYNC_DELAY());
        sync.executeSync(address(account), _old(oldValidator), initData);

        require(!account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)), "old validator not removed");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)), "new validator not installed");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not synced");
        require(account.guardianThreshold() == 1, "guardian threshold not synced");
        require(sync.lastAppliedL1Version(address(account)) == 1, "l1 version not recorded");
        (,,,,,,, uint48 readyAt,,,) = sync.pendingSyncs(address(account));
        require(readyAt == 0, "pending sync not cleared");
        syncId;
    }

    function testSyncRejectsMissingProofWrongAppAccountAndStaleVersion() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 1);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        MockKeystoreProofVerifier(address(sync.proofVerifier())).setEnabled(false);
        (bool rejectedProof,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        config,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        address(newValidator),
                        keccak256(initData)
                    )
                )
            );
        require(!rejectedProof, "disabled proof verifier accepted");
        MockKeystoreProofVerifier(address(sync.proofVerifier())).setEnabled(true);

        ILoomKeystore.KeystoreConfig memory wrongAppConfig = config;
        wrongAppConfig.appAccountRoot = keccak256("wrong app root");
        (bool rejectedWrongApp,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        wrongAppConfig,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        address(newValidator),
                        keccak256(initData)
                    )
                )
            );
        require(!rejectedWrongApp, "wrong app account root accepted");

        _propose(sync, keystore, account, oldValidator, newValidator, initData);
        vm.warp(block.timestamp + sync.SYNC_DELAY());
        sync.executeSync(address(account), _old(oldValidator), initData);

        MockValidator anotherValidator = new MockValidator();
        (bool rejectedStale,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        config,
                        "",
                        new bytes32[](0),
                        _old(newValidator),
                        address(anotherValidator),
                        keccak256(initData)
                    )
                )
            );
        require(!rejectedStale, "stale l1 version accepted");
    }

    function testSyncCancellationAndConfigInvalidation() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 2);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);

        bytes32 digest = sync.cancelDigest(address(account), syncId, account.configVersion(), 0);
        sync.cancelSyncWithGuardians(address(account), _guardianApprovals(digest));
        (,,,,,,, uint48 cancelledReadyAt,,,) = sync.pendingSyncs(address(account));
        require(cancelledReadyAt == 0, "guardian cancellation failed");
        require(sync.syncNonces(address(account)) == 1, "cancel nonce not consumed");

        _updateConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 2);
        _propose(sync, keystore, account, oldValidator, newValidator, initData);
        _scheduleGuardianConfig(account, keccak256("local guardian root"), 1);
        vm.warp(block.timestamp + sync.SYNC_DELAY());
        (bool rejectedStaleAccount,) = address(sync)
            .call(
                abi.encodeCall(KeystoreSyncRecoveryModule.executeSync, (address(account), _old(oldValidator), initData))
            );
        require(!rejectedStaleAccount, "sync survived local config change");
    }

    function testSyncRejectsDuplicatePendingWrongRootExpiryAndUnauthorizedCancel() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 2);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        ILoomKeystore.KeystoreConfig memory wrongValidatorRoot = config;
        wrongValidatorRoot.validatorRoot = keccak256("wrong validator root");
        (bool rejectedWrongRoot,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        wrongValidatorRoot,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        address(newValidator),
                        keccak256(initData)
                    )
                )
            );
        require(!rejectedWrongRoot, "wrong validator root accepted");

        _propose(sync, keystore, account, oldValidator, newValidator, initData);
        (bool rejectedDuplicate,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        config,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        address(newValidator),
                        keccak256(initData)
                    )
                )
            );
        require(!rejectedDuplicate, "duplicate pending sync accepted");

        (bool rejectedUnauthorizedCancel,) =
            address(sync).call(abi.encodeCall(KeystoreSyncRecoveryModule.cancelRecovery, (address(account))));
        require(!rejectedUnauthorizedCancel, "non-account cancelled sync");

        vm.warp(block.timestamp + sync.SYNC_DELAY() + sync.SYNC_WINDOW() + 1);
        (bool rejectedExpired,) = address(sync)
            .call(
                abi.encodeCall(KeystoreSyncRecoveryModule.executeSync, (address(account), _old(oldValidator), initData))
            );
        require(!rejectedExpired, "expired sync executed");
    }

    function testGuardianSyncCancellationRejectsDuplicateAndMissingApprovals() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), address(newValidator), keccak256(initData), 2);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);
        bytes32 digest = sync.cancelDigest(address(account), syncId, account.configVersion(), 0);
        KeystoreSyncRecoveryModule.GuardianApproval[] memory approvals = _guardianApprovals(digest);

        KeystoreSyncRecoveryModule.GuardianApproval[] memory missing =
            new KeystoreSyncRecoveryModule.GuardianApproval[](1);
        missing[0] = approvals[0];
        (bool rejectedMissing,) = address(sync)
            .call(abi.encodeCall(KeystoreSyncRecoveryModule.cancelSyncWithGuardians, (address(account), missing)));
        require(!rejectedMissing, "missing guardian threshold accepted");

        KeystoreSyncRecoveryModule.GuardianApproval[] memory duplicate =
            new KeystoreSyncRecoveryModule.GuardianApproval[](2);
        duplicate[0] = approvals[0];
        duplicate[1] = approvals[0];
        (bool rejectedDuplicate,) = address(sync)
            .call(abi.encodeCall(KeystoreSyncRecoveryModule.cancelSyncWithGuardians, (address(account), duplicate)));
        require(!rejectedDuplicate, "duplicate guardian accepted");
    }

    function testSyncConstructorModuleTypeAccountCancelAndInvalidExecutionBranches() public {
        LoomKeystore keystore = new LoomKeystore();
        MockKeystoreProofVerifier verifier = new MockKeystoreProofVerifier();

        (bool rejectedZeroKeystore,) =
            address(this).call(abi.encodeCall(this.deploySyncModule, (address(0), address(verifier))));
        require(!rejectedZeroKeystore, "zero keystore accepted");

        KeystoreSyncRecoveryModule sync = new KeystoreSyncRecoveryModule(address(keystore), verifier);
        require(sync.isModuleType(ModuleType.RECOVERY), "recovery module type unsupported");
        require(!sync.isModuleType(ModuleType.HOOK), "hook module type accepted");

        (
            LoomAccount account,
            KeystoreSyncRecoveryModule accountSync,
            LoomKeystore accountKeystore,
            MockValidator oldValidator
        ) = _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(accountKeystore, accountSync, address(account), address(newValidator), keccak256(initData), 2);
        _propose(accountSync, accountKeystore, account, oldValidator, newValidator, initData);

        (bool rejectedWrongOldSet,) = address(accountSync)
            .call(
                abi.encodeCall(KeystoreSyncRecoveryModule.executeSync, (address(account), new address[](0), initData))
            );
        require(!rejectedWrongOldSet, "wrong old validator set accepted");

        bytes memory cancel = abi.encodeCall(KeystoreSyncRecoveryModule.cancelRecovery, (address(account)));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(accountSync), 0, cancel)));
        (,,,,,,, uint48 readyAt,,,) = accountSync.pendingSyncs(address(account));
        require(readyAt == 0, "account cancellation failed");
    }

    function deploySyncModule(address keystore, address verifier) external returns (KeystoreSyncRecoveryModule) {
        return new KeystoreSyncRecoveryModule(keystore, MockKeystoreProofVerifier(verifier));
    }

    function _accountWithSync()
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
            address(this),
            _guardianRoot(),
            2,
            keccak256(abi.encode("keystore-sync-config", address(oldValidator), address(sync))),
            modules
        );
    }

    function _registerConfig(
        LoomKeystore keystore,
        KeystoreSyncRecoveryModule sync,
        address account,
        address newValidator,
        bytes32 initDataHash,
        uint8 newGuardianThreshold
    ) internal {
        keystore.register(
            IDENTITY_ID,
            address(this),
            sync.singleValidatorRoot(newValidator, initDataHash),
            NEW_GUARDIAN_ROOT,
            sync.appAccountLeaf(account),
            newGuardianThreshold
        );
    }

    function _updateConfig(
        LoomKeystore keystore,
        KeystoreSyncRecoveryModule sync,
        address account,
        address newValidator,
        bytes32 initDataHash,
        uint8 newGuardianThreshold
    ) internal {
        keystore.updateConfig(
            IDENTITY_ID,
            sync.singleValidatorRoot(newValidator, initDataHash),
            NEW_GUARDIAN_ROOT,
            sync.appAccountLeaf(account),
            newGuardianThreshold
        );
    }

    function _propose(
        KeystoreSyncRecoveryModule sync,
        LoomKeystore keystore,
        LoomAccount account,
        MockValidator oldValidator,
        MockValidator newValidator,
        bytes memory initData
    ) internal returns (bytes32 syncId) {
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);
        syncId = sync.proposeSync(
            address(account),
            IDENTITY_ID,
            config,
            "",
            new bytes32[](0),
            _old(oldValidator),
            address(newValidator),
            keccak256(initData)
        );
    }

    function _old(MockValidator oldValidator) internal pure returns (address[] memory validators) {
        validators = new address[](1);
        validators[0] = address(oldValidator);
    }

    function _scheduleGuardianConfig(LoomAccount account, bytes32 newRoot, uint8 newThreshold) internal {
        bytes memory data = abi.encodeCall(LoomAccount.setGuardianConfig, (newRoot, newThreshold));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, data, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, data);
    }

    function _guardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _secondGuardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(SECOND_GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("second-guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _guardianRoot() internal returns (bytes32) {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        return first <= second ? keccak256(abi.encodePacked(first, second)) : keccak256(abi.encodePacked(second, first));
    }

    function _guardianApprovals(bytes32 digest)
        internal
        returns (KeystoreSyncRecoveryModule.GuardianApproval[] memory approvals)
    {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        approvals = new KeystoreSyncRecoveryModule.GuardianApproval[](2);
        if (first <= second) {
            approvals[0] = _approval(GUARDIAN_KEY, "guardian-salt", second, digest);
            approvals[1] = _approval(SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
        } else {
            approvals[0] = _approval(SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
            approvals[1] = _approval(GUARDIAN_KEY, "guardian-salt", second, digest);
        }
    }

    function _approval(uint256 privateKey, string memory saltText, bytes32 sibling, bytes32 digest)
        internal
        returns (KeystoreSyncRecoveryModule.GuardianApproval memory approval)
    {
        address guardian = vm.addr(privateKey);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = KeystoreSyncRecoveryModule.GuardianApproval({
            verifier: address(guardianVerifier),
            keyCommitment: keccak256(abi.encode(guardian)),
            salt: keccak256(bytes(saltText)),
            signature: _signature(privateKey, digest),
            proof: proof
        });
    }

    function _signature(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
