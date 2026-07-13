// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmECDSAMultiAccount {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointECDSAMultiAccountTest {
    VmECDSAMultiAccount internal constant vm =
        VmECDSAMultiAccount(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;

    EntryPoint internal entryPoint;
    ECDSAValidator internal validator;
    PolicyHook internal hook;
    LoomAccountFactory internal factory;
    MockTarget internal aliceTarget;
    MockTarget internal bobTarget;

    function setUp() public {
        entryPoint = new EntryPoint();
        validator = new ECDSAValidator();
        hook = new PolicyHook();

        LoomAccount.ModuleInit[] memory implementationModules = _modules(address(0xA11CE));
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
        aliceTarget = new MockTarget();
        bobTarget = new MockTarget();
    }

    function testCounterfactualAccountsUseRealEcdsaSignaturesInSingleBundle() public {
        (address alice, PackedUserOperation memory aliceOp) =
            _signedCounterfactualOperation(keccak256("real-ecdsa-alice"), ALICE_KEY, aliceTarget, 71);
        (address bob, PackedUserOperation memory bobOp) =
            _signedCounterfactualOperation(keccak256("real-ecdsa-bob"), BOB_KEY, bobTarget, 72);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = aliceOp;
        ops[1] = bobOp;
        _handleOps(ops);

        require(alice != bob, "counterfactual accounts collided");
        require(alice.code.length != 0 && bob.code.length != 0, "bundle did not deploy both accounts");
        require(validator.owners(alice) == vm.addr(ALICE_KEY), "Alice owner initialization drifted");
        require(validator.owners(bob) == vm.addr(BOB_KEY), "Bob owner initialization drifted");
        require(aliceTarget.value() == 71, "Alice operation missing");
        require(bobTarget.value() == 72, "Bob operation missing");
        require(entryPoint.getNonce(alice, 0) == 1, "Alice nonce missing");
        require(entryPoint.getNonce(bob, 0) == 1, "Bob nonce missing");
    }

    function testCrossAccountEcdsaSignatureReplayRevertsWholeBundle() public {
        (address alice, PackedUserOperation memory aliceOp) =
            _signedCounterfactualOperation(keccak256("real-ecdsa-replay-alice"), ALICE_KEY, aliceTarget, 81);
        (address bob, PackedUserOperation memory bobOp) =
            _signedCounterfactualOperation(keccak256("real-ecdsa-replay-bob"), ALICE_KEY, aliceTarget, 81);
        require(alice != bob, "replay fixture accounts collided");
        bobOp.signature = aliceOp.signature;

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = aliceOp;
        ops[1] = bobOp;

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA24 signature error"));
        _handleOps(ops);

        require(alice.code.length == 0 && bob.code.length == 0, "failed validation persisted deployment");
        require(validator.owners(alice) == address(0), "failed bundle persisted Alice owner");
        require(validator.owners(bob) == address(0), "failed bundle persisted Bob owner");
        require(aliceTarget.value() == 0, "failed validation executed bundle state");
        require(entryPoint.getNonce(alice, 0) == 0, "failed bundle consumed Alice nonce");
        require(entryPoint.getNonce(bob, 0) == 0, "failed bundle consumed Bob nonce");
    }

    function _signedCounterfactualOperation(bytes32 salt, uint256 ownerKey, MockTarget operationTarget, uint256 value)
        internal
        returns (address sender, PackedUserOperation memory op)
    {
        address owner = vm.addr(ownerKey);
        LoomAccount.ModuleInit[] memory modules = _modules(owner);
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        vm.deal(sender, 1 ether);

        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(operationTarget), 0, abi.encodeCall(MockTarget.setValue, (value)));
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
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
    }

    function _handleOps(PackedUserOperation[] memory ops) internal {
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
    }

    receive() external payable {}
}
