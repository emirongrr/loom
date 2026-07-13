// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

contract ScalingHook is ILoomHook {
    uint256 public preChecks;
    uint256 public postChecks;

    function preCheck(address, address, bytes calldata) external returns (bytes memory) {
        ++preChecks;
        return "";
    }

    function postCheck(address, bytes calldata) external {
        ++postChecks;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }
}

contract ExecutionGasScalingTest {
    function testBatchExecutionGasScalesApproximatelyLinearly() public {
        uint256 gasForOne = _measureBatch(1);
        uint256 gasForEight = _measureBatch(8);
        uint256 gasForThirtyTwo = _measureBatch(32);

        require(gasForEight > gasForOne, "eight-call batch did not cost more than one call");
        require(gasForThirtyTwo > gasForEight, "thirty-two-call batch did not cost more than eight calls");

        uint256 earlyMarginal = (gasForEight - gasForOne) / 7;
        uint256 laterMarginal = (gasForThirtyTwo - gasForEight) / 24;
        require(laterMarginal <= earlyMarginal * 2, "batch execution cost grew super-linearly");
    }

    function testMaximumHookCompositionExecutesBoundedBatch() public {
        uint256 hookCount = 8;
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](hookCount + 1);
        ScalingHook[] memory hooks = new ScalingHook[](hookCount);
        for (uint256 i; i < hookCount; ++i) {
            hooks[i] = new ScalingHook();
            modules[i] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hooks[i]), "");
        }
        modules[hookCount] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        require(account.MAX_HOOKS() == hookCount, "test does not exercise declared hook maximum");

        ExecutionLib.Execution[] memory executions = _executions(16);
        account.execute(account.BATCH_EXECUTION_MODE(), abi.encode(executions));

        for (uint256 i; i < hookCount; ++i) {
            require(hooks[i].preChecks() == 1, "maximum hook composition missed pre-check");
            require(hooks[i].postChecks() == 1, "maximum hook composition missed post-check");
        }
        for (uint256 i; i < executions.length; ++i) {
            require(MockTarget(payable(executions[i].target)).value() == i + 1, "bounded batch call missing");
        }
    }

    function _measureBatch(uint256 count) internal returns (uint256 gasUsed) {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount account =
            new LoomAccount(address(this), keccak256("guardians"), 1, keccak256(abi.encode(count)), modules);
        ExecutionLib.Execution[] memory executions = _executions(count);

        uint256 gasBefore = gasleft();
        account.execute(account.BATCH_EXECUTION_MODE(), abi.encode(executions));
        gasUsed = gasBefore - gasleft();
    }

    function _executions(uint256 count) internal returns (ExecutionLib.Execution[] memory executions) {
        executions = new ExecutionLib.Execution[](count);
        for (uint256 i; i < count; ++i) {
            MockTarget target = new MockTarget();
            executions[i] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (i + 1)));
        }
    }
}
