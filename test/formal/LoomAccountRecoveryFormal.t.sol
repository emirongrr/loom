// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalGuardianVerifier} from "./FormalHelpers.sol";

contract LoomAccountRecoveryFormal is FormalAccountBase {
    function check_recoveryCannotExecuteBeforeDelayAndReplacesCompleteSet() public {
        RecoveryManager recovery = new RecoveryManager();
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        MockValidator oldValidator = new MockValidator();
        MockValidator newValidator = new MockValidator();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = keccak256(abi.encode(address(verifier), address(verifier).codehash, keyCommitment, salt));
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount account = new LoomAccount(address(this), leaf, 1, keccak256("config"), modules);
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        RecoveryManager.GuardianApproval[] memory approvals = new RecoveryManager.GuardianApproval[](1);
        approvals[0] = RecoveryManager.GuardianApproval(address(verifier), keyCommitment, salt, "", new bytes32[](0));
        bytes32 newGuardianRoot = keccak256("new-guardians");
        recovery.proposeRecovery(
            address(account), oldValidators, address(newValidator), keccak256(bytes("")), newGuardianRoot, 1, approvals
        );

        (bool early,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), oldValidators, bytes(""))));
        assert(!early);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));

        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators, "");
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(oldValidator)));
        assert(account.guardianRoot() == newGuardianRoot);
    }
}
