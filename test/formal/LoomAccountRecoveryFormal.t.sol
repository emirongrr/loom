// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalGuardianVerifier, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountRecoveryFormal is FormalAccountBase {
    function test_GuardianProofCannotCountLeafTwice() public {
        check_GuardianProofCannotCountLeafTwice();
    }

    function check_GuardianProofCannotCountLeafTwice() public {
        RecoveryManager recovery = new RecoveryManager();
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        MockValidator oldValidator = new MockValidator();
        MockValidator newValidator = new MockValidator();
        bytes32 keyCommitment = keccak256("duplicate-guardian-key");
        bytes32 salt = keccak256("duplicate-guardian-salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(_entryPointAddress(), leaf, 2, keccak256("config"), modules);

        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](2);
        GuardianVerificationLib.Approval memory approval =
            GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        approvals[0] = approval;
        approvals[1] = approval;

        uint64 configVersionBefore = account.configVersion();
        (bool accepted, bytes memory revertData) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        oldValidators,
                        address(newValidator),
                        keccak256(bytes("")),
                        keccak256("replacement-guardians"),
                        1,
                        approvals
                    )
                )
            );

        assert(!accepted);
        assert(keccak256(revertData) == keccak256(abi.encodeWithSelector(RecoveryManager.InvalidRecovery.selector)));
        (
            bytes32 pendingOldValidatorsHash,
            address pendingNewValidator,
            bytes32 pendingInitDataHash,
            bytes32 pendingNewGuardianRoot,
            uint8 pendingNewGuardianThreshold,
            uint48 readyAt,
            uint48 expiresAt,
            uint64 pendingConfigVersion,
            uint64 pendingNonce
        ) = recovery.pendingRecoveries(address(account));
        assert(pendingOldValidatorsHash == bytes32(0));
        assert(pendingNewValidator == address(0));
        assert(pendingInitDataHash == bytes32(0));
        assert(pendingNewGuardianRoot == bytes32(0));
        assert(pendingNewGuardianThreshold == 0);
        assert(readyAt == 0);
        assert(expiresAt == 0);
        assert(pendingConfigVersion == 0);
        assert(pendingNonce == 0);
        assert(recovery.recoveryNonces(address(account)) == 0);
        assert(account.configVersion() == configVersionBefore);
        assert(account.guardianRoot() == leaf);
        assert(account.guardianThreshold() == 2);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_RecoveryDelayIsEnforced() public {
        check_RecoveryDelayIsEnforced();
    }

    function check_RecoveryDelayIsEnforced() public {
        RecoveryManager recovery = new RecoveryManager();
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        MockValidator oldValidator = new MockValidator();
        MockValidator newValidator = new MockValidator();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(_entryPointAddress(), leaf, 1, keccak256("config"), modules);
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        bytes32 newGuardianRoot = keccak256("new-guardians");
        recovery.proposeRecovery(
            address(account), oldValidators, address(newValidator), keccak256(bytes("")), newGuardianRoot, 1, approvals
        );

        (bool early,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), oldValidators, bytes(""))));
        assert(!early);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_RecoveryReplacesValidatorSet() public {
        check_RecoveryReplacesValidatorSet();
    }

    function check_RecoveryReplacesValidatorSet() public {
        RecoveryManager recovery = new RecoveryManager();
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        MockValidator oldValidator = new MockValidator();
        MockValidator newValidator = new MockValidator();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(_entryPointAddress(), leaf, 1, keccak256("config"), modules);
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        bytes32 newGuardianRoot = keccak256("new-guardians");
        recovery.proposeRecovery(
            address(account), oldValidators, address(newValidator), keccak256(bytes("")), newGuardianRoot, 1, approvals
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators, "");
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(account.guardianRoot() == newGuardianRoot);
    }

    function test_FrozenAccountOnlyAllowsRecoveryCancel() public {
        check_FrozenAccountOnlyAllowsRecoveryCancel();
    }

    function check_FrozenAccountOnlyAllowsRecoveryCancel() public {
        RecoveryManager recovery = new RecoveryManager();
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        MockValidator oldValidator = new MockValidator();
        MockValidator newValidator = new MockValidator();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(_entryPointAddress(), leaf, 1, keccak256("config"), modules);

        FormalTarget target = new FormalTarget();
        bytes memory targetCall = abi.encodeCall(FormalTarget.setValue, (uint256(7)));
        bytes memory scheduleTarget =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, targetCall, account.MIN_EXTERNAL_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, scheduleTarget));
        bytes32 scheduledId = keccak256(abi.encode(address(target), uint256(0), targetCall, account.configVersion()));

        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        recovery.proposeRecovery(
            address(account),
            oldValidators,
            address(newValidator),
            keccak256(bytes("")),
            keccak256("new-guardians"),
            1,
            approvals
        );

        account.freeze(address(verifier), keyCommitment, salt, new bytes32[](0), "");
        bytes memory cancelRecovery = abi.encodeCall(RecoveryManager.cancelRecovery, (address(account)));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(recovery), 0, cancelRecovery));
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        assert(readyAt == 0);
        assert(recovery.recoveryNonces(address(account)) == 1);

        bytes memory cancelScheduled = abi.encodeCall(LoomAccount.cancelScheduled, (scheduledId));
        (bool ordinaryCancel,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, cancelScheduled)))
                )
            );
        assert(!ordinaryCancel);
        assert(account.scheduledOperations(scheduledId) != 0);
    }
}
