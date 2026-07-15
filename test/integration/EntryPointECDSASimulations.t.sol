// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPointSimulations} from "account-abstraction/core/EntryPointSimulations.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IEntryPointSimulations} from "account-abstraction/interfaces/IEntryPointSimulations.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmECDSASimulations {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function revertToState(uint256 snapshotId) external returns (bool success);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function snapshotState() external returns (uint256 snapshotId);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointSimulationsHarness is EntryPointSimulations {
    // The simulation bytecode is normally injected at an initialized EntryPoint address for eth_call.
    // Expose the same domain/sender-creator initialization before this deployed harness hashes an operation.
    function initializeForTest() external {
        initSenderCreator();
    }
}

contract EntryPointECDSASimulationsTest {
    VmECDSASimulations internal constant vm =
        VmECDSASimulations(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant WRONG_KEY = 0xBAD;
    address payable internal constant BENEFICIARY = payable(address(0xBEEF));

    EntryPointSimulationsHarness internal simulations;
    ECDSAValidator internal validator;
    PolicyHook internal hook;
    LoomAccountFactory internal factory;
    MockTarget internal target;

    function setUp() public {
        simulations = new EntryPointSimulationsHarness();
        simulations.initializeForTest();
        validator = new ECDSAValidator();
        hook = new PolicyHook();

        LoomAccount.ModuleInit[] memory implementationModules = _modules(address(0xA11CE));
        LoomAccount implementation = new LoomAccount(
            address(simulations),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(simulations)), address(implementation));
        target = new MockTarget();
    }

    function testSimulateValidationReturnsPrefundAndRollsBackEthCallState() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("simulate-validation"));
        PackedUserOperation memory op = _signedOperation(sender, initCode, OWNER_KEY, 71);
        uint256 snapshotId = vm.snapshotState();

        IEntryPointSimulations.ValidationResult memory result = simulations.simulateValidation(op);

        require(result.returnInfo.preOpGas != 0, "simulation omitted pre-operation gas");
        require(result.returnInfo.prefund != 0, "simulation omitted required prefund");
        require(result.returnInfo.accountValidationData == 0, "valid account simulation reported failure");
        require(result.returnInfo.paymasterValidationData == 0, "native-gas simulation reported paymaster data");
        require(sender.code.length != 0, "simulation did not exercise counterfactual deployment");
        require(simulations.getNonce(sender, 0) == 1, "simulation did not exercise nonce validation");
        require(target.value() == 0, "validation simulation executed account call");

        require(vm.revertToState(snapshotId), "simulation state rollback failed");
        require(sender.code.length == 0, "eth_call rollback retained account deployment");
        require(simulations.getNonce(sender, 0) == 0, "eth_call rollback retained nonce consumption");
        require(simulations.balanceOf(sender) == 0, "eth_call rollback retained prefund deposit");
        require(sender.balance == 1 ether, "eth_call rollback retained account prefund transfer");
        require(address(simulations).balance == 0, "eth_call rollback retained EntryPoint funds");
        require(target.value() == 0, "eth_call rollback retained execution state");
    }

    function testSimulateHandleOpPredictsExecutionWithoutChangingInclusionState() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("simulate-handle-op"));
        PackedUserOperation memory op = _signedOperation(sender, initCode, OWNER_KEY, 81);
        uint256 snapshotId = vm.snapshotState();

        address simulator = address(0x51A);
        vm.startPrank(simulator, simulator);
        IEntryPointSimulations.ExecutionResult memory result =
            simulations.simulateHandleOp(op, address(target), abi.encodeWithSignature("value()"));
        vm.stopPrank();

        require(result.paid != 0, "execution simulation omitted gas charge");
        require(result.accountValidationData == 0, "valid execution simulation reported failure");
        require(result.paymasterValidationData == 0, "native-gas execution reported paymaster data");
        require(result.targetSuccess, "post-execution state probe failed");
        require(abi.decode(result.targetResult, (uint256)) == 81, "simulation state probe observed wrong result");
        require(target.value() == 81, "simulation did not exercise target execution");
        require(simulations.getNonce(sender, 0) == 1, "simulation did not exercise nonce consumption");

        require(vm.revertToState(snapshotId), "execution simulation state rollback failed");
        require(sender.code.length == 0, "execution simulation retained account deployment");
        require(simulations.getNonce(sender, 0) == 0, "execution simulation consumed inclusion nonce");
        require(sender.balance == 1 ether, "execution simulation retained account gas charge");
        require(address(simulations).balance == 0, "execution simulation retained EntryPoint funds");
        require(target.value() == 0, "execution simulation retained target state");

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        _handleOp(op);

        require(sender.code.length != 0, "simulated account failed inclusion deployment");
        require(simulations.getNonce(sender, 0) == 1, "included operation nonce missing");
        require(target.value() == 81, "included operation diverged from simulation");
        require(BENEFICIARY.balance > beneficiaryBefore, "included operation paid no beneficiary fee");
    }

    function testSimulationReportsBadSignatureBeforeInclusionRejectsIt() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("simulate-bad-signature"));
        PackedUserOperation memory op = _signedOperation(sender, initCode, WRONG_KEY, 91);
        uint256 snapshotId = vm.snapshotState();

        IEntryPointSimulations.ValidationResult memory result = simulations.simulateValidation(op);
        require(result.returnInfo.accountValidationData == 1, "simulation did not report signature failure");

        require(vm.revertToState(snapshotId), "failed simulation state rollback failed");
        uint256 beneficiaryBefore = BENEFICIARY.balance;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _handleOp(op);

        require(sender.code.length == 0, "rejected signature retained account deployment");
        require(simulations.getNonce(sender, 0) == 0, "rejected signature consumed nonce");
        require(target.value() == 0, "rejected signature executed target call");
        require(simulations.balanceOf(sender) == 0, "rejected signature retained prefund deposit");
        require(sender.balance == 1 ether, "rejected signature charged account funds");
        require(address(simulations).balance == 0, "rejected signature retained EntryPoint funds");
        require(BENEFICIARY.balance == beneficiaryBefore, "rejected signature paid beneficiary");
    }

    function _counterfactualAccount(bytes32 salt) internal returns (address sender, bytes memory initCode) {
        LoomAccount.ModuleInit[] memory modules = _modules(vm.addr(OWNER_KEY));
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        vm.deal(sender, 1 ether);
        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (salt, guardianRoot, 1, configHash, modules));
        initCode = abi.encodePacked(address(factory), factoryCall);
    }

    function _signedOperation(address sender, bytes memory initCode, uint256 signerKey, uint256 value)
        internal
        returns (PackedUserOperation memory op)
    {
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (value)));
        op = PackedUserOperation({
            sender: sender,
            nonce: simulations.getNonce(sender, 0),
            initCode: initCode,
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 userOpHash = simulations.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
    }

    function _handleOp(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        simulations.handleOps(ops, BENEFICIARY);
        vm.stopPrank();
    }

    receive() external payable {}
}
