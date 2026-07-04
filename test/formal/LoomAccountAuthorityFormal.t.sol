// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalGuardianVerifier, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountAuthorityFormal is FormalAccountBase {
    function test_ExternalCannotSetGuardianConfig() public {
        check_ExternalCannotSetGuardianConfig(keccak256("new-root"), 1);
    }

    function check_ExternalCannotSetGuardianConfig(bytes32 root, uint8 threshold) public {
        (LoomAccount account,) = _account();
        bytes32 rootBefore = account.guardianRoot();
        uint8 thresholdBefore = account.guardianThreshold();
        uint64 versionBefore = account.configVersion();

        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (root, threshold)));

        assert(!ok);
        assert(account.guardianRoot() == rootBefore);
        assert(account.guardianThreshold() == thresholdBefore);
        assert(account.configVersion() == versionBefore);
    }

    function test_GuardianlessBootstrapHasNoGuardianAuthority() public {
        check_GuardianlessBootstrapHasNoGuardianAuthority();
    }

    function check_GuardianlessBootstrapHasNoGuardianAuthority() public {
        (LoomAccount account,) = _unprotectedAccount();
        uint64 versionBefore = account.configVersion();

        (bool setOk,) =
            address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1))));
        (bool freezeOk,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.freeze,
                    (address(new FormalGuardianVerifier()), keccak256("key"), keccak256("salt"), new bytes32[](0), "")
                )
            );

        assert(!setOk);
        assert(!freezeOk);
        assert(!account.recoveryConfigured());
        assert(account.configVersion() == versionBefore);
    }

    function test_ExternalCannotRecoverConfiguration() public {
        check_ExternalCannotRecoverConfiguration();
    }

    function check_ExternalCannotRecoverConfiguration() public {
        (LoomAccount account, MockValidator oldValidator) = _account();
        MockValidator newValidator = new MockValidator();
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.recoverConfiguration,
                    (oldValidators, address(newValidator), bytes(""), keccak256("new-guardians"), uint8(1))
                )
            );

        assert(!ok);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_UnsupportedExecutionModeNeverExecutes() public {
        check_UnsupportedExecutionModeNeverExecutes(2);
    }

    function check_UnsupportedExecutionModeNeverExecutes(uint8 callType) public {
        if (callType <= 1) return;
        (LoomAccount account,) = _account();
        bytes32 mode = bytes32(uint256(callType) << 248);
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(address(this), 0, "");

        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (mode, abi.encode(execution))));

        assert(!ok);
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
        uint64 versionBefore = account.configVersion();
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));

        assert(!ok);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(account.configVersion() == versionBefore);
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

        bytes memory guardianUpdate = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1)));
        bytes memory scheduleUpdate =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, guardianUpdate, account.MIN_CONFIG_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, scheduleUpdate));
        uint64 versionBefore = account.configVersion();
        bytes32 hashBefore = account.configHash();
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, guardianUpdate);

        (bool staleExecuted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, targetCall)));

        assert(account.configVersion() > versionBefore);
        assert(account.configHash() != hashBefore);
        assert(!staleExecuted);
        assert(target.value() == 0);
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
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));

        vm.prank(address(verifier));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))));

        assert(!ok);
        assert(target.value() == 0);
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

        vm.prank(address(oldValidator));
        (bool guardianOk,) = address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (root, threshold)));
        vm.prank(address(oldValidator));
        (bool recoveryOk,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.recoverConfiguration,
                    (oldValidators, address(newValidator), bytes(""), keccak256("new-guardians"), uint8(1))
                )
            );

        assert(!guardianOk);
        assert(!recoveryOk);
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
        bytes memory noop = "";

        (bool scheduleOk,) = address(account)
            .call(abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, noop, account.MIN_CONFIG_DELAY())));
        (bool cancelOk,) = address(account).call(abi.encodeCall(LoomAccount.cancelScheduled, (operationId)));
        (bool installOk,) = address(account)
            .call(abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(newValidator), bytes(""))));
        (bool uninstallOk,) = address(account)
            .call(abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes(""))));
        (bool unfreezeOk,) = address(account).call(abi.encodeCall(LoomAccount.unfreeze, ()));

        assert(!scheduleOk);
        assert(!cancelOk);
        assert(!installOk);
        assert(!uninstallOk);
        assert(!unfreezeOk);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }
}
