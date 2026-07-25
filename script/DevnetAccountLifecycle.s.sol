// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {P256Validator} from "../src/validators/P256Validator.sol";

interface IDevnetTarget {
    function setValue(uint256 value) external;
    function value() external view returns (uint256);
}

/// End-to-end account lifecycle against a live devnet, contracts only.
///
/// Drives the REAL production path — EntryPoint.handleOps -> factory initCode
/// -> P256Validator WebAuthn verification -> account execution — using a
/// software P-256 key in place of a device authenticator. The WebAuthn
/// envelope is byte-identical to a platform passkey, so the contracts cannot
/// tell the difference; this exercises Loom's behaviour, not a mock.
///
/// Broadcasts against the deployment produced by DeployDevnet. No bundler, no
/// app, no SDK: the account is created and then used entirely through the
/// deployed factory, validator, and EntryPoint.
contract DevnetAccountLifecycle is Script {
    uint256 internal constant P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 internal constant P256_HALF_ORDER = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    struct Ctx {
        IEntryPoint entryPoint;
        LoomAccountFactory factory;
        P256Validator validator;
        address policyHook;
        address account;
        uint256 p256Key;
        bytes32 p256X;
        bytes32 p256Y;
        string rpId;
        string origin;
    }

    event DevnetLifecycleAccount(address indexed account);
    event DevnetLifecycleExecuted(address indexed account, address target, uint256 value);

    function run() external {
        Ctx memory ctx;
        uint256 deployerKey = vm.envUint("DEVNET_DEPLOYER_PRIVATE_KEY");
        ctx.entryPoint = IEntryPoint(vm.envAddress("DEVNET_ENTRYPOINT"));
        ctx.factory = LoomAccountFactory(vm.envAddress("DEVNET_FACTORY"));
        ctx.validator = P256Validator(vm.envAddress("DEVNET_P256_VALIDATOR"));
        ctx.policyHook = vm.envAddress("DEVNET_POLICY_HOOK");
        address target = vm.envAddress("DEVNET_TARGET");
        ctx.p256Key = vm.envUint("DEVNET_P256_PRIVATE_KEY");
        ctx.p256X = vm.envBytes32("DEVNET_P256_X");
        ctx.p256Y = vm.envBytes32("DEVNET_P256_Y");
        ctx.rpId = vm.envOr("DEVNET_RP_ID", string("wallet.example"));
        ctx.origin = vm.envOr("DEVNET_ORIGIN", string("https://wallet.example"));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, ctx.policyHook, "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(ctx.validator),
            abi.encodeCall(
                P256Validator.initialize,
                // sha256 for rpIdHash: a real authenticator puts sha256(rpId) in
                // authenticatorData[0:32], which WebAuthnP256.verify compares against
                // this registered value. originHash stays keccak256 — the library
                // keccak-hashes the origin bytes it receives.
                (ctx.p256X, ctx.p256Y, sha256(bytes(ctx.rpId)), keccak256(bytes(ctx.origin)), ctx.policyHook)
            )
        );

        bytes32 salt = keccak256(abi.encode("loom.devnet.lifecycle", ctx.p256X, ctx.p256Y));
        bytes32 guardianRoot = keccak256("loom.devnet.lifecycle.guardian-root");
        bytes32 configHash = keccak256("loom.devnet.lifecycle.config");
        ctx.account = ctx.factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        emit DevnetLifecycleAccount(ctx.account);

        // --- Op 1: create the account and execute a call in one UserOperation.
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(target, 0, abi.encodeCall(IDevnetTarget.setValue, (777)));
        bytes memory callData =
            abi.encodeCall(LoomAccount.execute, (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(execution)));
        bytes memory initCode = abi.encodePacked(
            address(ctx.factory),
            abi.encodeCall(ctx.factory.createAccount, (salt, guardianRoot, 1, configHash, modules))
        );

        vm.startBroadcast(deployerKey);
        ctx.entryPoint.depositTo{value: 0.05 ether}(ctx.account);
        _submit(ctx, initCode, callData);
        vm.stopBroadcast();

        require(ctx.account.code.length != 0, "E2E: account was not deployed");
        require(IDevnetTarget(target).value() == 777, "E2E: first user operation did not execute");
        emit DevnetLifecycleExecuted(ctx.account, target, 777);

        // --- Op 2: a second call on the now-deployed account (no initCode).
        ExecutionLib.Execution memory second =
            ExecutionLib.Execution(target, 0, abi.encodeCall(IDevnetTarget.setValue, (1337)));
        bytes memory secondCallData =
            abi.encodeCall(LoomAccount.execute, (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(second)));

        vm.startBroadcast(deployerKey);
        _submit(ctx, "", secondCallData);
        vm.stopBroadcast();

        require(IDevnetTarget(target).value() == 1337, "E2E: second user operation did not execute");
        emit DevnetLifecycleExecuted(ctx.account, target, 1337);
    }

    function _submit(Ctx memory ctx, bytes memory initCode, bytes memory callData) internal {
        PackedUserOperation memory op;
        op.sender = ctx.account;
        op.nonce = ctx.entryPoint.getNonce(ctx.account, 0);
        op.initCode = initCode;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(6_000_000) << 128) | uint256(1_500_000));
        op.preVerificationGas = 200_000;
        op.gasFees = bytes32((uint256(2 gwei) << 128) | uint256(block.basefee + 2 gwei));

        bytes32 userOpHash = ctx.entryPoint.getUserOpHash(op);
        op.signature = _webAuthnSignature(ctx, userOpHash);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ctx.entryPoint.handleOps(ops, payable(vm.addr(vm.envUint("DEVNET_DEPLOYER_PRIVATE_KEY"))));
    }

    function _webAuthnSignature(Ctx memory ctx, bytes32 userOpHash) internal pure returns (bytes memory) {
        bytes memory authenticatorData = bytes.concat(sha256(bytes(ctx.rpId)), hex"05");
        bytes memory clientDataJSON = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            _base64Url(userOpHash),
            bytes('","origin":"'),
            bytes(ctx.origin),
            bytes('","crossOrigin":false}')
        );
        bytes32 signedHash = sha256(bytes.concat(authenticatorData, sha256(clientDataJSON)));
        (bytes32 r, bytes32 s) = vm.signP256(ctx.p256Key, signedHash);
        if (uint256(s) > P256_HALF_ORDER) s = bytes32(P256_ORDER - uint256(s));

        return abi.encode(
            address(ctx.validator),
            abi.encode(
                P256Validator.WebAuthnSignature({
                    authenticatorData: authenticatorData,
                    clientDataJSON: clientDataJSON,
                    origin: bytes(ctx.origin),
                    r: r,
                    s: s
                })
            )
        );
    }

    function _base64Url(bytes32 input) internal pure returns (bytes memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory output = new bytes(43);
        bytes memory raw = abi.encodePacked(input);
        uint256 outIndex;
        for (uint256 i; i < 32; i += 3) {
            uint256 remaining = 32 - i;
            uint24 chunk = uint24(uint8(raw[i])) << 16;
            if (remaining > 1) chunk |= uint24(uint8(raw[i + 1])) << 8;
            if (remaining > 2) chunk |= uint24(uint8(raw[i + 2]));
            output[outIndex++] = table[(chunk >> 18) & 0x3f];
            output[outIndex++] = table[(chunk >> 12) & 0x3f];
            if (remaining > 1) output[outIndex++] = table[(chunk >> 6) & 0x3f];
            if (remaining > 2) output[outIndex++] = table[chunk & 0x3f];
        }
        return output;
    }
}
