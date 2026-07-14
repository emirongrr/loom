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

interface VmECDSANonceKeys {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointECDSANonceKeysTest {
    VmECDSANonceKeys internal constant vm = VmECDSANonceKeys(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint192 internal constant SECONDARY_NONCE_KEY = 7;

    EntryPoint internal entryPoint;
    ECDSAValidator internal validator;
    PolicyHook internal hook;
    LoomAccountFactory internal factory;
    MockTarget internal firstTarget;
    MockTarget internal secondTarget;

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
        firstTarget = new MockTarget();
        secondTarget = new MockTarget();
    }

    function testCounterfactualAccountUsesIndependentNonceKeysInSingleBundle() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("independent-nonce-keys"));
        uint256 primaryNonce = entryPoint.getNonce(sender, 0);
        uint256 secondaryNonce = entryPoint.getNonce(sender, SECONDARY_NONCE_KEY);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedOperation(sender, primaryNonce, initCode, firstTarget, 71);
        ops[1] = _signedOperation(sender, secondaryNonce, "", secondTarget, 72);
        _handleOps(ops);

        require(sender.code.length != 0, "bundle did not deploy account");
        require(validator.owners(sender) == vm.addr(OWNER_KEY), "owner initialization drifted");
        require(firstTarget.value() == 71, "primary nonce-key operation missing");
        require(secondTarget.value() == 72, "secondary nonce-key operation missing");
        require(entryPoint.getNonce(sender, 0) == primaryNonce + 1, "primary nonce key did not advance");
        require(
            entryPoint.getNonce(sender, SECONDARY_NONCE_KEY) == secondaryNonce + 1,
            "secondary nonce key did not advance"
        );
    }

    function testDuplicateNonceKeySequenceRevertsWholeValidationBundle() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("duplicate-nonce-key"));
        uint256 nonce = entryPoint.getNonce(sender, 0);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedOperation(sender, nonce, initCode, firstTarget, 81);
        ops[1] = _signedOperation(sender, nonce, "", secondTarget, 82);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA25 invalid account nonce"));
        _handleOps(ops);

        require(sender.code.length == 0, "failed bundle persisted account deployment");
        require(validator.owners(sender) == address(0), "failed bundle persisted owner initialization");
        require(firstTarget.value() == 0 && secondTarget.value() == 0, "failed validation executed bundle state");
        require(entryPoint.getNonce(sender, 0) == nonce, "failed bundle consumed nonce");
    }

    function _counterfactualAccount(bytes32 salt) internal returns (address sender, bytes memory initCode) {
        LoomAccount.ModuleInit[] memory modules = _modules(vm.addr(OWNER_KEY));
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        vm.deal(sender, 2 ether);

        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (salt, guardianRoot, 1, configHash, modules));
        initCode = abi.encodePacked(address(factory), factoryCall);
    }

    function _signedOperation(
        address sender,
        uint256 nonce,
        bytes memory initCode,
        MockTarget operationTarget,
        uint256 value
    ) internal returns (PackedUserOperation memory op) {
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(
            address(operationTarget), 0, abi.encodeCall(MockTarget.setValue, (value))
        );
        op = PackedUserOperation({
            sender: sender,
            nonce: nonce,
            initCode: initCode,
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, userOpHash);
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
