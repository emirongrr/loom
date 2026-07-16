// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmGasScaling {
    function expectRevert(bytes calldata revertData) external;
}

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

contract ReturndataBomb {
    function returnBytes(uint256 size) external pure {
        assembly {
            return(0, size)
        }
    }

    function revertBytes(uint256 size) external pure {
        assembly {
            revert(0, size)
        }
    }
}

contract ExecutionGasScalingTest {
    VmGasScaling internal constant vm = VmGasScaling(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant MAXIMUM_COMPOSITION_GAS_CEILING = 2_000_000;

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

        ExecutionLib.Execution[] memory executions = _executions(account.MAX_BATCH_SIZE());
        uint256 gasBefore = gasleft();
        account.execute(account.BATCH_EXECUTION_MODE(), abi.encode(executions));
        uint256 gasUsed = gasBefore - gasleft();
        require(gasUsed <= MAXIMUM_COMPOSITION_GAS_CEILING, "maximum composition exceeded gas ceiling");

        for (uint256 i; i < hookCount; ++i) {
            require(hooks[i].preChecks() == 1, "maximum hook composition missed pre-check");
            require(hooks[i].postChecks() == 1, "maximum hook composition missed post-check");
        }
        for (uint256 i; i < executions.length; ++i) {
            require(MockTarget(payable(executions[i].target)).value() == i + 1, "bounded batch call missing");
        }
    }

    function testOversizedBatchFailsBeforeHooksOrTargets() public {
        ScalingHook hook = new ScalingHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockTarget target = new MockTarget();

        ExecutionLib.Execution[] memory executions = new ExecutionLib.Execution[](account.MAX_BATCH_SIZE() + 1);
        for (uint256 i; i < executions.length; ++i) {
            executions[i] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (i + 1)));
        }

        bytes32 batchMode = account.BATCH_EXECUTION_MODE();
        vm.expectRevert(abi.encodeWithSelector(LoomAccount.BatchLimitExceeded.selector));
        account.execute(batchMode, abi.encode(executions));
        require(hook.preChecks() == 0 && hook.postChecks() == 0, "oversized batch reached hooks");
        require(target.value() == 0, "oversized batch reached target");
    }

    function testSuccessfulReturndataIsDiscardedAndOversizedRevertIsBounded() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        ReturndataBomb bomb = new ReturndataBomb();
        uint256 bombSize = 512 * 1024;
        bytes32 singleMode = account.SINGLE_EXECUTION_MODE();

        uint256 gasBefore = gasleft();
        account.execute(
            singleMode,
            abi.encode(ExecutionLib.Execution(address(bomb), 0, abi.encodeCall(ReturndataBomb.returnBytes, (bombSize))))
        );
        uint256 gasUsed = gasBefore - gasleft();
        require(gasUsed < 1_000_000, "successful returndata consumed unbounded caller gas");

        uint256 revertSize = account.MAX_REVERT_DATA_LENGTH() + 1;
        vm.expectRevert(abi.encodeWithSelector(LoomAccount.ReturnDataLimitExceeded.selector, revertSize));
        account.execute(
            singleMode,
            abi.encode(
                ExecutionLib.Execution(address(bomb), 0, abi.encodeCall(ReturndataBomb.revertBytes, (revertSize)))
            )
        );
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
