// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalGuardianVerifier, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountAuthorityFormal is FormalAccountBase {
    struct AuthoritySnapshot {
        bytes32 guardianRoot;
        bytes32 configHash;
        uint256 validatorCount;
        address[] validators;
        uint256[] directNonces;
        uint64 configVersion;
        uint48 frozenUntil;
        uint8 guardianThreshold;
        bool recoveryConfigured;
        bool executingScheduled;
    }

    function _snapshotAuthority(LoomAccount account) internal view returns (AuthoritySnapshot memory snapshot) {
        snapshot.guardianRoot = account.guardianRoot();
        snapshot.configHash = account.configHash();
        snapshot.validatorCount = account.validatorCount();
        snapshot.validators = new address[](snapshot.validatorCount);
        snapshot.directNonces = new uint256[](snapshot.validatorCount);
        for (uint256 i; i < snapshot.validatorCount; ++i) {
            snapshot.validators[i] = account.validatorAt(i);
            snapshot.directNonces[i] = account.directExecutionNonces(snapshot.validators[i]);
        }
        snapshot.configVersion = account.configVersion();
        snapshot.frozenUntil = account.frozenUntil();
        snapshot.guardianThreshold = account.guardianThreshold();
        snapshot.recoveryConfigured = account.recoveryConfigured();
        snapshot.executingScheduled = account.isExecutingScheduled();
    }

    function _assertAuthorityUnchanged(LoomAccount account, AuthoritySnapshot memory snapshot) internal view {
        assert(account.guardianRoot() == snapshot.guardianRoot);
        assert(account.configHash() == snapshot.configHash);
        assert(account.validatorCount() == snapshot.validatorCount);
        for (uint256 i; i < snapshot.validatorCount; ++i) {
            assert(account.validatorAt(i) == snapshot.validators[i]);
            assert(account.isModuleInstalled(ModuleType.VALIDATOR, snapshot.validators[i]));
            assert(account.directExecutionNonces(snapshot.validators[i]) == snapshot.directNonces[i]);
        }
        assert(account.configVersion() == snapshot.configVersion);
        assert(account.frozenUntil() == snapshot.frozenUntil);
        assert(account.guardianThreshold() == snapshot.guardianThreshold);
        assert(account.recoveryConfigured() == snapshot.recoveryConfigured);
        assert(account.isExecutingScheduled() == snapshot.executingScheduled);
    }

    function _assertRevert(bytes memory revertData, bytes4 expectedSelector) internal pure {
        assert(keccak256(revertData) == keccak256(abi.encodeWithSelector(expectedSelector)));
    }

    function test_ExternalCannotSetGuardianConfig() public {
        check_ExternalCannotSetGuardianConfig(keccak256("new-root"), 1);
    }

    function check_ExternalCannotSetGuardianConfig(bytes32 root, uint8 threshold) public {
        (LoomAccount account, MockValidator validator) = _account();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);

        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (root, threshold)));

        assert(!ok);
        _assertRevert(revertData, LoomAccount.OperationNotReady.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
    }

    function test_GuardianlessBootstrapHasNoGuardianAuthority() public {
        check_GuardianlessBootstrapHasNoGuardianAuthority();
    }

    function check_GuardianlessBootstrapHasNoGuardianAuthority() public {
        (LoomAccount account, MockValidator validator) = _unprotectedAccount();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = account.guardianLeaf(address(verifier), keyCommitment, salt);

        (bool setOk, bytes memory setRevertData) =
            address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1))));
        (bool freezeOk, bytes memory freezeRevertData) = address(account)
            .call(abi.encodeCall(LoomAccount.freeze, (address(verifier), keyCommitment, salt, new bytes32[](0), "")));

        assert(!setOk);
        _assertRevert(setRevertData, LoomAccount.OperationNotReady.selector);
        assert(!freezeOk);
        _assertRevert(freezeRevertData, LoomAccount.InvalidModule.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.freezeNonces(leaf) == 0);
        assert(account.lastFreezeConfigVersion(leaf) == 0);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
    }

    function test_ExternalCannotRecoverConfiguration() public {
        check_ExternalCannotRecoverConfiguration();
    }

    function check_ExternalCannotRecoverConfiguration() public {
        (LoomAccount account, MockValidator oldValidator) = _account();
        MockValidator newValidator = new MockValidator();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);

        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.recoverConfiguration,
                    (oldValidators, address(newValidator), bytes(""), keccak256("new-guardians"), uint8(1))
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidModule.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_UnsupportedExecutionModeNeverExecutes() public {
        check_UnsupportedExecutionModeNeverExecutes(2);
    }

    function check_UnsupportedExecutionModeNeverExecutes(uint8 callType) public {
        if (callType <= 1) return;
        (LoomAccount account, MockValidator validator) = _account();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        FormalTarget target = new FormalTarget();
        bytes32 mode = bytes32(uint256(callType) << 248);
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (uint256(1))));

        vm.prank(account.entryPoint());
        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (mode, abi.encode(execution))));

        assert(!ok);
        _assertRevert(revertData, LoomAccount.UnsupportedExecutionMode.selector);
        assert(target.value() == 0);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
    }

    function test_CannotRemoveLastValidator() public {
        check_CannotRemoveLastValidator();
    }

    function check_CannotRemoveLastValidator() public {
        (LoomAccount account, MockValidator validator) = _account();
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, schedule));
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        bytes32 operationId = keccak256(abi.encode(address(account), uint256(0), uninstall, account.configVersion()));
        uint48 readyAtBefore = account.scheduledOperations(operationId);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidModule.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.scheduledOperations(operationId) == readyAtBefore);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
    }

    function test_ConfigUpdateInvalidatesStaleSchedule() public {
        check_ConfigUpdateInvalidatesStaleSchedule();
    }

    function check_ConfigUpdateInvalidatesStaleSchedule() public {
        (LoomAccount account,) = _account();
        FormalTarget target = new FormalTarget();
        bytes memory targetCall = abi.encodeCall(FormalTarget.setValue, (uint256(7)));
        bytes memory scheduleTarget =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, targetCall, account.MIN_EXTERNAL_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, scheduleTarget));
        bytes32 staleOperationId =
            keccak256(abi.encode(address(target), uint256(0), targetCall, account.configVersion()));
        uint48 staleReadyAt = account.scheduledOperations(staleOperationId);

        bytes memory guardianUpdate = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1)));
        bytes memory scheduleUpdate =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, guardianUpdate, account.MIN_CONFIG_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, scheduleUpdate));
        uint64 versionBefore = account.configVersion();
        bytes32 hashBefore = account.configHash();
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, guardianUpdate);
        AuthoritySnapshot memory updatedState = _snapshotAuthority(account);

        (bool staleExecuted, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, targetCall)));

        assert(account.configVersion() > versionBefore);
        assert(account.configHash() != hashBefore);
        assert(!staleExecuted);
        _assertRevert(revertData, LoomAccount.OperationNotScheduled.selector);
        assert(target.value() == 0);
        _assertAuthorityUnchanged(account, updatedState);
        assert(account.scheduledOperations(staleOperationId) == staleReadyAt);
    }

    function testFuzz_GuardianCannotPerformValidatorAction(uint256 newValue) public {
        check_GuardianCannotPerformValidatorAction(newValue);
    }

    function check_GuardianCannotPerformValidatorAction(uint256 newValue) public {
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account = new LoomAccount(
            address(this), _guardianLeaf(verifier, keyCommitment, salt), 1, keccak256("config"), modules
        );
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));

        vm.prank(address(verifier));
        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))));

        assert(!ok);
        _assertRevert(revertData, LoomAccount.OnlyEntryPoint.selector);
        assert(target.value() == 0);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.directExecutionNonces(address(validator)) == 0);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
    }

    function testFuzz_ValidatorCannotPerformGuardianRecoveryAction(bytes32 root, uint8 threshold) public {
        check_ValidatorCannotPerformGuardianRecoveryAction(root, threshold);
    }

    function check_ValidatorCannotPerformGuardianRecoveryAction(bytes32 root, uint8 threshold) public {
        (LoomAccount account, MockValidator oldValidator) = _account();
        MockValidator newValidator = new MockValidator();
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        bytes32 rootBefore = account.guardianRoot();
        uint8 thresholdBefore = account.guardianThreshold();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);

        vm.prank(address(oldValidator));
        (bool guardianOk, bytes memory guardianRevertData) =
            address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (root, threshold)));
        vm.prank(address(oldValidator));
        (bool recoveryOk, bytes memory recoveryRevertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.recoverConfiguration,
                    (oldValidators, address(newValidator), bytes(""), keccak256("new-guardians"), uint8(1))
                )
            );

        assert(!guardianOk);
        _assertRevert(guardianRevertData, LoomAccount.OperationNotReady.selector);
        assert(!recoveryOk);
        _assertRevert(recoveryRevertData, LoomAccount.InvalidModule.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.guardianRoot() == rootBefore);
        assert(account.guardianThreshold() == thresholdBefore);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function testFuzz_PrivilegedAccountFunctionsRejectExternalCall(bytes32 operationId) public {
        check_PrivilegedAccountFunctionsRejectExternalCall(operationId);
    }

    function check_PrivilegedAccountFunctionsRejectExternalCall(bytes32 operationId) public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        AuthoritySnapshot memory beforeState = _snapshotAuthority(account);
        bytes memory noop = "";
        bytes32 attemptedOperationId =
            keccak256(abi.encode(address(account), uint256(0), noop, account.configVersion()));

        (bool scheduleOk, bytes memory scheduleRevertData) = address(account)
            .call(abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, noop, account.MIN_CONFIG_DELAY())));
        (bool cancelOk, bytes memory cancelRevertData) =
            address(account).call(abi.encodeCall(LoomAccount.cancelScheduled, (operationId)));
        (bool installOk, bytes memory installRevertData) = address(account)
            .call(abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(newValidator), bytes(""))));
        (bool uninstallOk, bytes memory uninstallRevertData) = address(account)
            .call(abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes(""))));
        (bool unfreezeOk, bytes memory unfreezeRevertData) =
            address(account).call(abi.encodeCall(LoomAccount.unfreeze, ()));

        assert(!scheduleOk);
        _assertRevert(scheduleRevertData, LoomAccount.OnlySelf.selector);
        assert(!cancelOk);
        _assertRevert(cancelRevertData, LoomAccount.OnlySelf.selector);
        assert(!installOk);
        _assertRevert(installRevertData, LoomAccount.OperationNotReady.selector);
        assert(!uninstallOk);
        _assertRevert(uninstallRevertData, LoomAccount.OperationNotReady.selector);
        assert(!unfreezeOk);
        _assertRevert(unfreezeRevertData, LoomAccount.OnlySelf.selector);
        _assertAuthorityUnchanged(account, beforeState);
        assert(account.scheduledOperations(attemptedOperationId) == 0);
        assert(account.scheduledOperations(operationId) == 0);
        assert(account.directExecutionNonces(address(validator)) == 0);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }
}
