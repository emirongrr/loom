// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC7579HookAdapter} from "./mocks/MockERC7579HookAdapter.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";

interface Vm {
    function warp(uint256 timestamp) external;
}

contract ERC7579LimitedProfileTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    LoomAccount internal account;
    MockValidator internal validator;
    MockTarget internal target;

    function setUp() public {
        validator = new MockValidator();
        target = new MockTarget();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testReportsOnlyLimitedRuntimeModuleProfile() public view {
        require(account.supportsModule(ModuleType.VALIDATOR), "validator type missing");
        require(account.supportsModule(ModuleType.HOOK), "hook type missing");
        require(!account.supportsModule(ModuleType.EXECUTOR), "executor type exposed");
        require(!account.supportsModule(ModuleType.FALLBACK), "fallback type exposed");
        require(account.supportsModule(ModuleType.RECOVERY), "Loom recovery extension missing");
        require(!account.supportsModule(type(uint256).max), "unknown type exposed");
    }

    function testReportsAndExecutesOnlyExactSupportedModes() public {
        bytes32 single = account.SINGLE_EXECUTION_MODE();
        bytes32 batch = account.BATCH_EXECUTION_MODE();
        require(account.supportsExecutionMode(single), "single not reported");
        require(account.supportsExecutionMode(batch), "batch not reported");
        require(!account.supportsExecutionMode(bytes32(uint256(1) << 240)), "try mode reported");
        require(!account.supportsExecutionMode(bytes32(uint256(0xff) << 248)), "delegatecall reported");
        require(!account.supportsExecutionMode(bytes32(uint256(1))), "mode payload reported");

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        calls[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (2)));
        account.execute(batch, abi.encode(calls));
        require(target.value() == 2, "atomic batch did not execute in order");
    }

    function testExecutorEntryPointAlwaysReverts() public {
        (bool ok,) = address(account)
            .call(abi.encodeCall(LoomAccount.executeFromExecutor, (account.SINGLE_EXECUTION_MODE(), bytes(""))));
        require(!ok, "executor entry point enabled");
    }

    function testStandardLifecycleAdapterRequiresTimelockedLoomInstallation() public {
        MockERC7579HookAdapter adapter = new MockERC7579HookAdapter();
        bytes memory installData = bytes("install");
        bytes memory lifecycle = abi.encodeCall(adapter.onInstall, (installData));

        (bool lifecycleBypass,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        account.SINGLE_EXECUTION_MODE(),
                        abi.encode(ExecutionLib.Execution(address(adapter), 0, lifecycle))
                    )
                )
            );
        require(!lifecycleBypass, "lifecycle initialized outside module installation");
        require(!adapter.isInitialized(address(account)), "bypass changed lifecycle state");

        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(adapter), lifecycle));

        (bool direct,) = address(account).call(install);
        require(!direct, "module lifecycle bypassed timelock");
        _scheduleAndExecute(address(account), install, account.MIN_CONFIG_DELAY());

        require(account.isModuleInstalled(ModuleType.HOOK, address(adapter), ""), "adapter not installed");
        require(adapter.isInitialized(address(account)), "standard onInstall not called");
        require(adapter.installDataHashes(address(account)) == keccak256(installData), "install data changed");

        bytes memory uninstallData = bytes("uninstall");
        bytes memory deLifecycle = abi.encodeCall(adapter.onUninstall, (uninstallData));
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(adapter), deLifecycle));
        _scheduleAndExecute(address(account), uninstall, account.MIN_CONFIG_DELAY());

        require(!account.isModuleInstalled(ModuleType.HOOK, address(adapter), ""), "adapter remained installed");
        require(!adapter.isInitialized(address(account)), "standard onUninstall not called");
        require(adapter.uninstallDataHashes(address(account)) == keccak256(uninstallData), "uninstall data changed");
    }

    function testStandardLifecycleAdapterRejectsDuplicateAndInvalidLifecycleCalls() public {
        MockERC7579HookAdapter adapter = new MockERC7579HookAdapter();
        (bool directInstall,) = address(adapter).call(abi.encodeCall(adapter.onInstall, (bytes(""))));
        require(!directInstall, "non-account lifecycle install accepted");

        bytes memory lifecycle = abi.encodeCall(adapter.onInstall, (bytes("install")));
        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(adapter), lifecycle));
        _scheduleAndExecute(address(account), install, account.MIN_CONFIG_DELAY());

        ExecutionLib.Execution memory duplicate =
            ExecutionLib.Execution(address(adapter), 0, abi.encodeCall(adapter.onInstall, (bytes(""))));
        (bool duplicateInstall,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(duplicate))));
        require(!duplicateInstall, "duplicate lifecycle install accepted");

        ExecutionLib.Execution memory prematureUninstall =
            ExecutionLib.Execution(address(adapter), 0, abi.encodeCall(adapter.onUninstall, (bytes(""))));
        (bool invalidUninstall,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(prematureUninstall))));
        require(!invalidUninstall, "lifecycle uninstall accepted while module installed");

        require(adapter.isModuleType(ModuleType.HOOK), "adapter hook type rejected");
        require(!adapter.isModuleType(ModuleType.VALIDATOR), "adapter validator type accepted");
    }

    function testRecoveryModuleTargetsUseConfigDelay() public {
        RecoveryManager recovery = new RecoveryManager();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount recoveryAccount =
            new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        bytes memory recoveryCall = abi.encodeCall(RecoveryManager.cancelRecovery, (address(recoveryAccount)));
        bytes memory shortSchedule = abi.encodeCall(
            LoomAccount.scheduleCall, (address(recovery), 0, recoveryCall, recoveryAccount.MIN_EXTERNAL_DELAY())
        );
        (bool shortAccepted,) = address(recoveryAccount)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        recoveryAccount.SINGLE_EXECUTION_MODE(),
                        abi.encode(ExecutionLib.Execution(address(recoveryAccount), 0, shortSchedule))
                    )
                )
            );
        require(!shortAccepted, "recovery config accepted short delay");

        bytes memory validSchedule = abi.encodeCall(
            LoomAccount.scheduleCall, (address(recovery), 0, recoveryCall, recoveryAccount.MIN_CONFIG_DELAY())
        );
        recoveryAccount.execute(
            recoveryAccount.SINGLE_EXECUTION_MODE(),
            abi.encode(ExecutionLib.Execution(address(recoveryAccount), 0, validSchedule))
        );
    }

    function _scheduleAndExecute(address scheduledTarget, bytes memory data, uint48 delay) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (scheduledTarget, 0, data, delay));
        account.execute(
            account.SINGLE_EXECUTION_MODE(), abi.encode(ExecutionLib.Execution(address(account), 0, schedule))
        );
        vm.warp(block.timestamp + delay);
        account.executeScheduled(scheduledTarget, 0, data);
    }
}
