// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {MockPaymaster} from "../mocks/MockPaymaster.sol";

interface VmEntryPoint {
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointIntegrationTest {
    VmEntryPoint internal constant vm = VmEntryPoint(address(uint160(uint256(keccak256("hevm cheat code")))));
    EntryPoint internal entryPoint;
    LoomAccountFactory internal factory;
    MockValidator internal validator;
    MockTarget internal target;

    function setUp() public {
        entryPoint = new EntryPoint();
        validator = new MockValidator();
        LoomAccount.ModuleInit[] memory implementationModules = new LoomAccount.ModuleInit[](1);
        implementationModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
        target = new MockTarget();
    }

    function testFullCounterfactualUserOperationLifecycle() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 salt = keccak256("entrypoint-integration");
        address sender = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        vm.deal(sender, 1 ether);

        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (42)));
        bytes memory factoryCall = abi.encodeCall(
            LoomAccountFactory.createAccount, (salt, keccak256("guardians"), 1, keccak256("config"), modules)
        );

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = PackedUserOperation({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: abi.encode(address(validator), bytes(""))
        });

        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
        require(sender.code.length != 0, "account not deployed");
        require(target.value() == 42, "user operation not executed");
    }

    function testCounterfactualBatchUserOperationLifecycle() public {
        MockTarget secondTarget = new MockTarget();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 salt = keccak256("entrypoint-batch-integration");
        address sender = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        vm.deal(sender, 1 ether);

        ExecutionLib.Execution[] memory executions = new ExecutionLib.Execution[](2);
        executions[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (41)));
        executions[1] = ExecutionLib.Execution(address(secondTarget), 0, abi.encodeCall(MockTarget.setValue, (42)));
        bytes32 batchMode = bytes32(uint256(1) << 248);
        bytes memory factoryCall = abi.encodeCall(
            LoomAccountFactory.createAccount, (salt, keccak256("guardians"), 1, keccak256("config"), modules)
        );

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = PackedUserOperation({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(executions))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: abi.encode(address(validator), bytes(""))
        });

        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
        require(sender.code.length != 0, "batch account not deployed");
        require(target.value() == 41 && secondTarget.value() == 42, "batch user operation not executed");
    }

    function testCounterfactualPaymasterLifecycle() public {
        MockPaymaster paymaster = new MockPaymaster(IEntryPoint(address(entryPoint)));
        paymaster.deposit{value: 1 ether}();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 salt = keccak256("entrypoint-paymaster-integration");
        address sender = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (43)));
        bytes memory factoryCall = abi.encodeCall(
            LoomAccountFactory.createAccount, (salt, keccak256("guardians"), 1, keccak256("config"), modules)
        );

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = PackedUserOperation({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: abi.encodePacked(address(paymaster), uint128(1_000_000), uint128(1_000_000)),
            signature: abi.encode(address(validator), bytes(""))
        });

        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
        require(target.value() == 43, "sponsored operation not executed");
        require(paymaster.validations() == 1, "paymaster validation missing");
        require(paymaster.postOps() == 1, "paymaster postOp missing");
    }

    function testMultipleCounterfactualAccountsExecuteInSingleBundle() public {
        MockTarget secondTarget = new MockTarget();
        (address firstSender, PackedUserOperation memory firstOp) =
            _counterfactualOperation(keccak256("multi-account-first"), target, MockTarget.setValue.selector, 51);
        (address secondSender, PackedUserOperation memory secondOp) =
            _counterfactualOperation(keccak256("multi-account-second"), secondTarget, MockTarget.setValue.selector, 52);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = firstOp;
        ops[1] = secondOp;

        _handleOps(ops);

        require(firstSender != secondSender, "counterfactual accounts collided");
        require(firstSender.code.length != 0 && secondSender.code.length != 0, "bundle did not deploy both accounts");
        require(target.value() == 51, "first account operation missing");
        require(secondTarget.value() == 52, "second account operation missing");
        require(entryPoint.getNonce(firstSender, 0) == 1, "first account nonce missing");
        require(entryPoint.getNonce(secondSender, 0) == 1, "second account nonce missing");
    }

    function testExecutionRevertDoesNotRollbackIndependentOperationInBundle() public {
        MockTarget secondTarget = new MockTarget();
        (address revertingSender, PackedUserOperation memory revertingOp) =
            _counterfactualOperation(keccak256("multi-account-revert"), target, MockTarget.fail.selector, 0);
        (address successfulSender, PackedUserOperation memory successfulOp) =
            _counterfactualOperation(keccak256("multi-account-success"), secondTarget, MockTarget.setValue.selector, 53);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = revertingOp;
        ops[1] = successfulOp;

        _handleOps(ops);

        require(revertingSender.code.length != 0, "reverting account deployment rolled back");
        require(successfulSender.code.length != 0, "successful account was not deployed");
        require(target.value() == 0, "reverting operation changed target state");
        require(secondTarget.value() == 53, "independent operation was rolled back");
        require(entryPoint.getNonce(revertingSender, 0) == 1, "reverting execution did not consume validated nonce");
        require(entryPoint.getNonce(successfulSender, 0) == 1, "successful execution nonce missing");
    }

    function testInvalidSecondOperationRevertsValidationBundleWithExactIndex() public {
        MockTarget secondTarget = new MockTarget();
        (address firstSender, PackedUserOperation memory firstOp) =
            _counterfactualOperation(keccak256("invalid-bundle-first"), target, MockTarget.setValue.selector, 61);
        (address invalidSender, PackedUserOperation memory invalidOp) =
            _counterfactualOperation(keccak256("invalid-bundle-second"), secondTarget, MockTarget.setValue.selector, 62);
        invalidOp.signature = abi.encode(address(0xDEAD), bytes(""));
        vm.deal(address(this), 1 ether);
        entryPoint.depositTo{value: 1 ether}(invalidSender);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = firstOp;
        ops[1] = invalidOp;

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA24 signature error"));
        _handleOps(ops);

        require(
            firstSender.code.length == 0 && invalidSender.code.length == 0, "failed validation persisted deployment"
        );
        require(target.value() == 0 && secondTarget.value() == 0, "failed validation executed bundle state");
        require(entryPoint.getNonce(firstSender, 0) == 0, "failed bundle consumed first nonce");
        require(entryPoint.getNonce(invalidSender, 0) == 0, "failed bundle consumed invalid nonce");
    }

    function _counterfactualOperation(bytes32 salt, MockTarget operationTarget, bytes4 selector, uint256 value)
        internal
        returns (address sender, PackedUserOperation memory op)
    {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        vm.deal(sender, 1 ether);

        bytes memory targetCall = selector == MockTarget.setValue.selector
            ? abi.encodeCall(MockTarget.setValue, (value))
            : abi.encodeCall(MockTarget.fail, ());
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(address(operationTarget), 0, targetCall);
        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (salt, guardianRoot, 1, configHash, modules));

        op = PackedUserOperation({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: abi.encode(address(validator), bytes(""))
        });
    }

    function _handleOps(PackedUserOperation[] memory ops) internal {
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
    }

    receive() external payable {}
}
