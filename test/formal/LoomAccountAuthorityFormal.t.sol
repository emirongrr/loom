// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountAuthorityFormal is FormalAccountBase {
    function check_directGuardianConfigNeverSucceeds(bytes32 root, uint8 threshold) public {
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

    function check_directRecoveryNeverSucceeds() public {
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

    function check_unsupportedExecutionModeNeverExecutes(uint8 callType) public {
        if (callType <= 1) return;
        (LoomAccount account,) = _account();
        bytes32 mode = bytes32(uint256(callType) << 248);
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(address(this), 0, "");

        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (mode, abi.encode(execution))));

        assert(!ok);
    }

    function check_finalValidatorCannotBeRemoved() public {
        (LoomAccount account, MockValidator validator) = _account();
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        uint64 versionBefore = account.configVersion();
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));

        assert(!ok);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(account.configVersion() == versionBefore);
    }

    function check_configUpdateAdvancesVersionAndInvalidatesStaleSchedule() public {
        (LoomAccount account,) = _account();
        FormalTarget target = new FormalTarget();
        bytes memory targetCall = abi.encodeCall(FormalTarget.setValue, (uint256(7)));
        bytes memory scheduleTarget =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, targetCall, account.MIN_HIGH_RISK_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleTarget)));

        bytes memory guardianUpdate = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1)));
        bytes memory scheduleUpdate =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, guardianUpdate, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleUpdate)));
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
}
