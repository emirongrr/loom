// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";

interface VmWebAuthnLifecycle {
    function deal(address account, uint256 amount) external;
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
}

contract WebAuthnEntryPointLifecycleIntegrationTest {
    VmWebAuthnLifecycle internal constant vm =
        VmWebAuthnLifecycle(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant CHROME_WINDOWS_HELLO_FIXTURE = "fixtures/webauthn/corpus/chrome-windows-hello.json";
    bytes32 internal constant PUBLIC_KEY_X = 0xa105666d7e908a3a7ca8374578a7c611eec3d895a1caeed7708fa45eee2b7c6d;
    bytes32 internal constant PUBLIC_KEY_Y = 0x0990a8d407ec86237d2b8c53b8f2746cec14db09f0e9d0bdc64d448aa94ddb69;
    bytes32 internal constant SALT = keccak256("webauthn-entrypoint-lifecycle-v1");
    bytes32 internal constant GUARDIAN_ROOT = keccak256("webauthn-lifecycle-guardians");
    bytes32 internal constant CONFIG_HASH = keccak256("webauthn-lifecycle-config");
    bytes32 internal constant RP_ID_HASH = sha256("localhost");
    bytes32 internal constant ORIGIN_HASH = keccak256("http://localhost:8788");

    struct LifecycleContext {
        EntryPoint entryPoint;
        P256Validator validator;
        LoomAccountFactory factory;
        MockTarget target;
        address sender;
        PackedUserOperation op;
    }

    struct Fixture {
        bytes32 publicKeyX;
        bytes32 publicKeyY;
        bytes32 challenge;
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes origin;
        bytes32 r;
        bytes32 s;
    }

    function testChromeWindowsHelloFixtureExecutesAccountBoundUserOperation() public {
        Fixture memory fixture = _loadFixture(CHROME_WINDOWS_HELLO_FIXTURE);
        require(fixture.publicKeyX == PUBLIC_KEY_X, "fixture x mismatch");
        require(fixture.publicKeyY == PUBLIC_KEY_Y, "fixture y mismatch");

        bytes memory validatorSignature = abi.encode(
            P256Validator.WebAuthnSignature({
                authenticatorData: fixture.authenticatorData,
                clientDataJSON: fixture.clientDataJSON,
                origin: fixture.origin,
                r: fixture.r,
                s: fixture.s
            })
        );
        LifecycleContext memory context = _buildLifecycle(validatorSignature);
        bytes32 userOpHash = context.entryPoint.getUserOpHash(context.op);
        require(userOpHash == fixture.challenge, "fixture is not bound to lifecycle userOpHash");

        vm.deal(context.sender, 1 ether);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = context.op;
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        context.entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();

        require(context.sender.code.length != 0, "account not deployed");
        require(context.target.value() == 777, "account-bound user operation not executed");
    }

    function _buildLifecycle(bytes memory validatorSignature) internal returns (LifecycleContext memory context) {
        EntryPoint entryPoint = new EntryPoint();
        OZP256Verifier verifier = new OZP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();

        LoomAccount.ModuleInit[] memory implementationModules = new LoomAccount.ModuleInit[](1);
        implementationModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );

        LoomAccountFactory factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
        MockTarget target = new MockTarget();

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize, (PUBLIC_KEY_X, PUBLIC_KEY_Y, RP_ID_HASH, ORIGIN_HASH, address(hook))
            )
        );

        address sender = factory.getAddress(SALT, GUARDIAN_ROOT, 1, CONFIG_HASH, modules);
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (777)));
        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (SALT, GUARDIAN_ROOT, 1, CONFIG_HASH, modules));

        PackedUserOperation memory op = PackedUserOperation({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: abi.encode(address(validator), validatorSignature)
        });

        context = LifecycleContext({
            entryPoint: entryPoint, validator: validator, factory: factory, target: target, sender: sender, op: op
        });
    }

    function _loadFixture(string memory path) internal view returns (Fixture memory f) {
        string memory json = vm.readFile(path);
        f.publicKeyX = vm.parseJsonBytes32(json, ".publicKeyX");
        f.publicKeyY = vm.parseJsonBytes32(json, ".publicKeyY");
        f.challenge = vm.parseJsonBytes32(json, ".challenge");
        f.authenticatorData = vm.parseJsonBytes(json, ".authenticatorData");
        f.clientDataJSON = bytes(vm.parseJsonString(json, ".clientDataJSON"));
        f.origin = bytes(vm.parseJsonString(json, ".origin"));
        f.r = vm.parseJsonBytes32(json, ".r");
        f.s = vm.parseJsonBytes32(json, ".s");
    }
}
