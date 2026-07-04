// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
import {GuardianVerificationLib} from "../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../src/LoomAccount.sol";
import {EthereumL1KeystoreVerifier} from "../src/keystore/EthereumL1KeystoreVerifier.sol";
import {LoomKeystore} from "../src/keystore/LoomKeystore.sol";
import {KeystoreSyncRecoveryModule} from "../src/recovery/KeystoreSyncRecoveryModule.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {ILoomAccount} from "../src/interfaces/ILoomAccount.sol";
import {ILoomKeystore} from "../src/interfaces/ILoomKeystore.sol";
import {ILoomModule} from "../src/interfaces/ILoomModule.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockKeystoreProofVerifier} from "./mocks/MockKeystoreProofVerifier.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

contract RecoverySetCaller is ILoomModule {
    function recoverSet(
        LoomAccount account,
        address[] calldata oldValidators,
        ILoomAccount.RecoveryModuleInit[] calldata newValidators,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external {
        account.recoverConfigurationSet(oldValidators, newValidators, newGuardianRoot, newGuardianThreshold);
    }

    function recoverSingle(
        LoomAccount account,
        address[] calldata oldValidators,
        address newValidator,
        bytes calldata initData,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external {
        account.recoverConfiguration(oldValidators, newValidator, initData, newGuardianRoot, newGuardianThreshold);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.RECOVERY;
    }
}

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

        _registerConfig(keystore, sync, address(account), newValidator, initData, 1);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);

        (bool early,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), _old(oldValidator), _newValidators(newValidator, initData))
                )
            );
        require(!early, "sync executed before delay");

        vm.warp(block.timestamp + sync.SYNC_DELAY());
        sync.executeSync(address(account), _old(oldValidator), _newValidators(newValidator, initData));

        require(!account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)), "old validator not removed");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)), "new validator not installed");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not synced");
        require(account.guardianThreshold() == 1, "guardian threshold not synced");
        require(sync.lastAppliedL1Version(address(account)) == 1, "l1 version not recorded");
        (,,,,,,, uint48 readyAt,,,) = sync.pendingSyncs(address(account));
        require(readyAt == 0, "pending sync not cleared");
        syncId;
    }

    function testKeystoreSyncAcceptsDirectL1VerifierWithoutCrossChainMessage() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithDirectL1VerifierSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";

        _registerConfig(keystore, sync, address(account), newValidator, initData, 1);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        (bool rejectedMessageBytes,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        config,
                        hex"01",
                        new bytes32[](0),
                        _old(oldValidator),
                        _newValidators(newValidator, initData)
                    )
                )
            );
        require(!rejectedMessageBytes, "message bytes accepted as l1 proof");

        bytes32 syncId = sync.proposeSync(
            address(account),
            IDENTITY_ID,
            config,
            "",
            new bytes32[](0),
            _old(oldValidator),
            _newValidators(newValidator, initData)
        );
        require(syncId != bytes32(0), "l1 verifier sync not proposed");
    }

    function testSyncRejectsMissingProofWrongAppAccountAndStaleVersion() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), newValidator, initData, 1);
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
                        _newValidators(newValidator, initData)
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
                        _newValidators(newValidator, initData)
                    )
                )
            );
        require(!rejectedWrongApp, "wrong app account root accepted");

        _propose(sync, keystore, account, oldValidator, newValidator, initData);
        vm.warp(block.timestamp + sync.SYNC_DELAY());
        sync.executeSync(address(account), _old(oldValidator), _newValidators(newValidator, initData));

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
                        _newValidators(anotherValidator, initData)
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
        _registerConfig(keystore, sync, address(account), newValidator, initData, 2);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);

        bytes32 digest = sync.cancelDigest(address(account), syncId, account.configVersion(), 0);
        sync.cancelSyncWithGuardians(address(account), _guardianApprovals(digest));
        (,,,,,,, uint48 cancelledReadyAt,,,) = sync.pendingSyncs(address(account));
        require(cancelledReadyAt == 0, "guardian cancellation failed");
        require(sync.syncNonces(address(account)) == 1, "cancel nonce not consumed");

        _updateConfig(keystore, sync, address(account), newValidator, initData, 2);
        _propose(sync, keystore, account, oldValidator, newValidator, initData);
        _scheduleGuardianConfig(account, keccak256("local guardian root"), 1);
        vm.warp(block.timestamp + sync.SYNC_DELAY());
        (bool rejectedStaleAccount,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), _old(oldValidator), _newValidators(newValidator, initData))
                )
            );
        require(!rejectedStaleAccount, "sync survived local config change");
    }

    function testSyncRejectsDuplicatePendingWrongRootExpiryAndUnauthorizedCancel() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), newValidator, initData, 2);
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
                        _newValidators(newValidator, initData)
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
                        _newValidators(newValidator, initData)
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
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), _old(oldValidator), _newValidators(newValidator, initData))
                )
            );
        require(!rejectedExpired, "expired sync executed");
    }

    function testGuardianSyncCancellationRejectsDuplicateAndMissingApprovals() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator newValidator = new MockValidator();
        bytes memory initData = "";
        _registerConfig(keystore, sync, address(account), newValidator, initData, 2);
        bytes32 syncId = _propose(sync, keystore, account, oldValidator, newValidator, initData);
        bytes32 digest = sync.cancelDigest(address(account), syncId, account.configVersion(), 0);
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(digest);

        GuardianVerificationLib.Approval[] memory missing = new GuardianVerificationLib.Approval[](1);
        missing[0] = approvals[0];
        (bool rejectedMissing,) = address(sync)
            .call(abi.encodeCall(KeystoreSyncRecoveryModule.cancelSyncWithGuardians, (address(account), missing)));
        require(!rejectedMissing, "missing guardian threshold accepted");

        GuardianVerificationLib.Approval[] memory duplicate = new GuardianVerificationLib.Approval[](2);
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
        _registerConfig(accountKeystore, accountSync, address(account), newValidator, initData, 2);
        _propose(accountSync, accountKeystore, account, oldValidator, newValidator, initData);

        (bool rejectedWrongOldSet,) = address(accountSync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), new address[](0), _newValidators(newValidator, initData))
                )
            );
        require(!rejectedWrongOldSet, "wrong old validator set accepted");

        bytes memory cancel = abi.encodeCall(KeystoreSyncRecoveryModule.cancelRecovery, (address(account)));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(accountSync), 0, cancel)));
        (,,,,,,, uint48 readyAt,,,) = accountSync.pendingSyncs(address(account));
        require(readyAt == 0, "account cancellation failed");
    }

    function testKeystoreSyncAppliesArbitraryMultiValidatorRoot() public {
        (
            LoomAccount account,
            KeystoreSyncRecoveryModule sync,
            LoomKeystore keystore,
            MockValidator oldValidatorOne,
            MockValidator oldValidatorTwo
        ) = _accountWithTwoValidatorSync();
        MockValidator newValidatorOne = new MockValidator();
        MockValidator newValidatorTwo = new MockValidator();
        ILoomAccount.RecoveryModuleInit[] memory newValidators = _sortedNewValidators(newValidatorOne, newValidatorTwo);

        _registerConfigSet(keystore, sync, address(account), newValidators, 1);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);
        bytes32 syncId = sync.proposeSync(
            address(account),
            IDENTITY_ID,
            config,
            "",
            new bytes32[](0),
            _sortedOld(oldValidatorOne, oldValidatorTwo),
            newValidators
        );

        vm.warp(block.timestamp + sync.SYNC_DELAY());
        sync.executeSync(address(account), _sortedOld(oldValidatorOne, oldValidatorTwo), newValidators);

        require(syncId != bytes32(0), "sync id missing");
        require(account.validatorCount() == 2, "validator count not replaced");
        require(
            !account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidatorOne)), "old validator one retained"
        );
        require(
            !account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidatorTwo)), "old validator two retained"
        );
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidatorOne)), "new validator one missing");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidatorTwo)), "new validator two missing");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not synced");
        require(account.configVersion() == 2, "config version not advanced once");
    }

    function testKeystoreSyncRejectsMalformedMultiValidatorSet() public {
        (LoomAccount account, KeystoreSyncRecoveryModule sync, LoomKeystore keystore, MockValidator oldValidator) =
            _accountWithSync();
        MockValidator first = new MockValidator();
        MockValidator second = new MockValidator();
        ILoomAccount.RecoveryModuleInit[] memory sorted = _sortedNewValidators(first, second);
        _registerConfigSet(keystore, sync, address(account), sorted, 1);
        ILoomKeystore.KeystoreConfig memory config = keystore.getConfig(IDENTITY_ID);

        ILoomAccount.RecoveryModuleInit[] memory duplicate = new ILoomAccount.RecoveryModuleInit[](2);
        duplicate[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
        duplicate[1] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
        (bool rejectedDuplicate,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (address(account), IDENTITY_ID, config, "", new bytes32[](0), _old(oldValidator), duplicate)
                )
            );
        require(!rejectedDuplicate, "duplicate validator set accepted");

        ILoomAccount.RecoveryModuleInit[] memory wrongType = new ILoomAccount.RecoveryModuleInit[](1);
        wrongType[0] = ILoomAccount.RecoveryModuleInit(ModuleType.HOOK, address(first), "");
        (bool rejectedWrongType,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (address(account), IDENTITY_ID, config, "", new bytes32[](0), _old(oldValidator), wrongType)
                )
            );
        require(!rejectedWrongType, "non-validator set accepted");

        ILoomAccount.RecoveryModuleInit[] memory empty = new ILoomAccount.RecoveryModuleInit[](0);
        ILoomKeystore.KeystoreConfig memory emptyRootConfig = config;
        emptyRootConfig.validatorRoot = sync.validatorSetRoot(empty);
        (bool rejectedEmpty,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (address(account), IDENTITY_ID, emptyRootConfig, "", new bytes32[](0), _old(oldValidator), empty)
                )
            );
        require(!rejectedEmpty, "empty validator set accepted");

        ILoomAccount.RecoveryModuleInit[] memory unsorted = _unsortedNewValidators(first, second);
        ILoomKeystore.KeystoreConfig memory unsortedRootConfig = config;
        unsortedRootConfig.validatorRoot = sync.validatorSetRoot(unsorted);
        (bool rejectedUnsorted,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        unsortedRootConfig,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        unsorted
                    )
                )
            );
        require(!rejectedUnsorted, "unsorted validator set accepted");

        ILoomAccount.RecoveryModuleInit[] memory overlap = _newValidators(oldValidator, "");
        ILoomKeystore.KeystoreConfig memory overlapRootConfig = config;
        overlapRootConfig.validatorRoot = sync.validatorSetRoot(overlap);
        (bool rejectedOverlap,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.proposeSync,
                    (
                        address(account),
                        IDENTITY_ID,
                        overlapRootConfig,
                        "",
                        new bytes32[](0),
                        _old(oldValidator),
                        overlap
                    )
                )
            );
        require(!rejectedOverlap, "installed validator overlap accepted");

        (bool rejectedWrongExecuteSet,) = address(sync)
            .call(
                abi.encodeCall(
                    KeystoreSyncRecoveryModule.executeSync,
                    (address(account), _old(oldValidator), _newValidators(first, "changed"))
                )
            );
        require(!rejectedWrongExecuteSet, "wrong execute validator set accepted");
    }

    function testAccountRecoverySetRejectsInvalidValidatorSetsAndGuardianConfig() public {
        RecoverySetCaller recovery = new RecoverySetCaller();
        MockValidator oldValidator = new MockValidator();
        MockValidator first = new MockValidator();
        MockValidator second = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(
            address(this),
            _guardianRoot(),
            2,
            keccak256(abi.encode("account-recovery-set", address(oldValidator), address(recovery))),
            modules
        );

        ILoomAccount.RecoveryModuleInit[] memory empty = new ILoomAccount.RecoveryModuleInit[](0);
        (bool rejectedUnauthorized,) = address(account)
            .call(
                abi.encodeCall(LoomAccount.recoverConfigurationSet, (_old(oldValidator), empty, NEW_GUARDIAN_ROOT, 1))
            );
        require(!rejectedUnauthorized, "account accepted unauthorized recovery set caller");

        (bool rejectedEmpty,) = address(recovery)
            .call(
                abi.encodeCall(RecoverySetCaller.recoverSet, (account, _old(oldValidator), empty, NEW_GUARDIAN_ROOT, 1))
            );
        require(!rejectedEmpty, "account accepted empty recovery set");

        ILoomAccount.RecoveryModuleInit[] memory overlap = _newValidators(oldValidator, "");
        (bool rejectedOverlap,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), overlap, NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedOverlap, "account accepted installed validator overlap");

        ILoomAccount.RecoveryModuleInit[] memory unsorted = _unsortedNewValidators(first, second);
        (bool rejectedUnsorted,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), unsorted, NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedUnsorted, "account accepted unsorted recovery set");

        ILoomAccount.RecoveryModuleInit[] memory wrongType = new ILoomAccount.RecoveryModuleInit[](1);
        wrongType[0] = ILoomAccount.RecoveryModuleInit(ModuleType.HOOK, address(first), "");
        (bool rejectedWrongType,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), wrongType, NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedWrongType, "account accepted non-validator recovery set");

        ILoomAccount.RecoveryModuleInit[] memory valid = _newValidators(first, "");
        (bool rejectedSameGuardianRoot,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), valid, account.guardianRoot(), 1)
                )
            );
        require(!rejectedSameGuardianRoot, "account accepted unchanged guardian root");

        (bool rejectedZeroRoot,) = address(recovery)
            .call(abi.encodeCall(RecoverySetCaller.recoverSet, (account, _old(oldValidator), valid, bytes32(0), 1)));
        require(!rejectedZeroRoot, "account accepted zero guardian root");

        (bool rejectedZeroThreshold,) = address(recovery)
            .call(
                abi.encodeCall(RecoverySetCaller.recoverSet, (account, _old(oldValidator), valid, NEW_GUARDIAN_ROOT, 0))
            );
        require(!rejectedZeroThreshold, "account accepted zero guardian threshold");

        (bool rejectedHighThreshold,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), valid, NEW_GUARDIAN_ROOT, 33)
                )
            );
        require(!rejectedHighThreshold, "account accepted high guardian threshold");

        (bool rejectedEmptyOldSet,) = address(recovery)
            .call(
                abi.encodeCall(RecoverySetCaller.recoverSet, (account, new address[](0), valid, NEW_GUARDIAN_ROOT, 1))
            );
        require(!rejectedEmptyOldSet, "account accepted empty old validator set");

        ILoomAccount.RecoveryModuleInit[] memory codeLess = new ILoomAccount.RecoveryModuleInit[](1);
        codeLess[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(0xBEEF), "");
        (bool rejectedCodeLess,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSet, (account, _old(oldValidator), codeLess, NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedCodeLess, "account accepted code-less validator");

        (bool rejectedSingleCodeLess,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSingle,
                    (account, _old(oldValidator), address(0xBEEF), "", NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedSingleCodeLess, "single recovery accepted code-less validator");

        (bool rejectedSingleWrongType,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoverySetCaller.recoverSingle,
                    (account, _old(oldValidator), address(recovery), "", NEW_GUARDIAN_ROOT, 1)
                )
            );
        require(!rejectedSingleWrongType, "single recovery accepted non-validator module");
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

    function _accountWithTwoValidatorSync()
        internal
        returns (
            LoomAccount account,
            KeystoreSyncRecoveryModule sync,
            LoomKeystore keystore,
            MockValidator oldValidatorOne,
            MockValidator oldValidatorTwo
        )
    {
        keystore = new LoomKeystore();
        MockKeystoreProofVerifier verifier = new MockKeystoreProofVerifier();
        sync = new KeystoreSyncRecoveryModule(address(keystore), verifier);
        oldValidatorOne = new MockValidator();
        oldValidatorTwo = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        address[] memory sortedOld = _sortedOld(oldValidatorOne, oldValidatorTwo);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, sortedOld[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, sortedOld[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(sync), "");
        account = new LoomAccount(
            address(this),
            _guardianRoot(),
            2,
            keccak256(abi.encode("keystore-sync-config", sortedOld[0], sortedOld[1], address(sync))),
            modules
        );
    }

    function _accountWithDirectL1VerifierSync()
        internal
        returns (
            LoomAccount account,
            KeystoreSyncRecoveryModule sync,
            LoomKeystore keystore,
            MockValidator oldValidator
        )
    {
        keystore = new LoomKeystore();
        EthereumL1KeystoreVerifier verifier = new EthereumL1KeystoreVerifier(address(keystore));
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
        MockValidator newValidator,
        bytes memory initData,
        uint8 newGuardianThreshold
    ) internal {
        ILoomAccount.RecoveryModuleInit[] memory validators = _newValidators(newValidator, initData);
        _registerConfigSet(keystore, sync, account, validators, newGuardianThreshold);
    }

    function _registerConfigSet(
        LoomKeystore keystore,
        KeystoreSyncRecoveryModule sync,
        address account,
        ILoomAccount.RecoveryModuleInit[] memory validators,
        uint8 newGuardianThreshold
    ) internal {
        keystore.register(
            IDENTITY_ID,
            address(this),
            sync.validatorSetRoot(validators),
            NEW_GUARDIAN_ROOT,
            sync.appAccountLeaf(account),
            newGuardianThreshold
        );
    }

    function _updateConfig(
        LoomKeystore keystore,
        KeystoreSyncRecoveryModule sync,
        address account,
        MockValidator newValidator,
        bytes memory initData,
        uint8 newGuardianThreshold
    ) internal {
        ILoomAccount.RecoveryModuleInit[] memory validators = _newValidators(newValidator, initData);
        keystore.updateConfig(
            IDENTITY_ID,
            sync.validatorSetRoot(validators),
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
            _newValidators(newValidator, initData)
        );
    }

    function _newValidators(MockValidator newValidator, bytes memory initData)
        internal
        pure
        returns (ILoomAccount.RecoveryModuleInit[] memory validators)
    {
        validators = new ILoomAccount.RecoveryModuleInit[](1);
        validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(newValidator), initData);
    }

    function _sortedNewValidators(MockValidator first, MockValidator second)
        internal
        pure
        returns (ILoomAccount.RecoveryModuleInit[] memory validators)
    {
        validators = new ILoomAccount.RecoveryModuleInit[](2);
        if (address(first) < address(second)) {
            validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
            validators[1] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(second), "");
        } else {
            validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(second), "");
            validators[1] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
        }
    }

    function _unsortedNewValidators(MockValidator first, MockValidator second)
        internal
        pure
        returns (ILoomAccount.RecoveryModuleInit[] memory validators)
    {
        validators = new ILoomAccount.RecoveryModuleInit[](2);
        if (address(first) < address(second)) {
            validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(second), "");
            validators[1] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
        } else {
            validators[0] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(first), "");
            validators[1] = ILoomAccount.RecoveryModuleInit(ModuleType.VALIDATOR, address(second), "");
        }
    }

    function _old(MockValidator oldValidator) internal pure returns (address[] memory validators) {
        validators = new address[](1);
        validators[0] = address(oldValidator);
    }

    function _sortedOld(MockValidator first, MockValidator second) internal pure returns (address[] memory validators) {
        validators = new address[](2);
        if (address(first) < address(second)) {
            validators[0] = address(first);
            validators[1] = address(second);
        } else {
            validators[0] = address(second);
            validators[1] = address(first);
        }
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

    function _guardianApprovals(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        approvals = new GuardianVerificationLib.Approval[](2);
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
        returns (GuardianVerificationLib.Approval memory approval)
    {
        address guardian = vm.addr(privateKey);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = GuardianVerificationLib.Approval({
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
