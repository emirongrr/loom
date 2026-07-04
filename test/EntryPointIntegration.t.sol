// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockPaymaster} from "./mocks/MockPaymaster.sol";

interface VmEntryPoint {
    function deal(address account, uint256 amount) external;
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

    receive() external payable {}
}
