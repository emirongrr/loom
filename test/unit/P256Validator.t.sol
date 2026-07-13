// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "../../src/validators/P256Validator.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockP256Verifier} from "../mocks/MockP256Verifier.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {DenyPolicyHook} from "../mocks/DenyPolicyHook.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmP256 {
    function warp(uint256) external;
}

contract P256ValidatorTest {
    VmP256 internal constant vm = VmP256(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testWebAuthnChecksChallengeOriginTypeAndFlags() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes32 hash = keccak256("user-operation");
        bytes memory challenge = _base64Url(hash);
        bytes memory origin = bytes("https://wallet.example");
        bytes memory clientData = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            challenge,
            bytes('","origin":"'),
            origin,
            bytes('","crossOrigin":false}')
        );
        bytes memory authenticatorData = bytes.concat(keccak256("wallet.example"), hex"05");
        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: authenticatorData,
            clientDataJSON: clientData,
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    bytes32(uint256(1)),
                    bytes32(uint256(2)),
                    keccak256("wallet.example"),
                    keccak256(origin),
                    address(hook)
                )
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                != ValidationDataLib.SIG_VALIDATION_FAILED,
            "valid WebAuthn rejected"
        );
        require(
            account.isValidSignature(hash, abi.encode(address(validator), abi.encode(signature)))
                == account.ERC1271_INVALID(),
            "primary ERC-1271 accepted"
        );

        signature.clientDataJSON = bytes.concat(clientData, bytes('"challenge":"'), challenge, bytes('"'));
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "duplicate challenge accepted"
        );

        signature.clientDataJSON = clientData;
        signature.s = bytes32(type(uint256).max);
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "high-s P-256 signature accepted"
        );

        signature.s = bytes32(uint256(1));
        signature.origin = bytes("https://evil.example");
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "wrong origin accepted"
        );

        signature.origin = origin;
        signature.authenticatorData = bytes.concat(keccak256("evil.example"), hex"05");
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "wrong rpId hash accepted"
        );

        signature.authenticatorData = bytes.concat(keccak256("wallet.example"), hex"01");
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "missing user verification accepted"
        );

        signature.authenticatorData = hex"00";
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "short authenticator data accepted"
        );

        signature.authenticatorData = bytes.concat(keccak256("wallet.example"), hex"05");
        signature.r = bytes32(0);
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "zero signature component accepted"
        );

        signature.r = bytes32(uint256(1));
        signature.clientDataJSON = new bytes(validator.MAX_CLIENT_DATA_JSON_LENGTH() + 1);
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "oversized client data accepted"
        );

        signature.clientDataJSON = clientData;
        signature.origin = new bytes(validator.MAX_ORIGIN_LENGTH() + 1);
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "oversized origin accepted"
        );
        signature.origin = origin;

        signature.clientDataJSON = bytes.concat(
            bytes('{"type":"webauthn.get","crossOrigin":false,"challenge":"'),
            challenge,
            bytes('","origin":"'),
            origin,
            bytes('","tokenBinding":{"status":"supported"}}')
        );
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                != ValidationDataLib.SIG_VALIDATION_FAILED,
            "reordered fields and extra tokenBinding field rejected"
        );

        signature.clientDataJSON = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            challenge,
            bytes('","origin":"'),
            origin,
            bytes('","crossOrigin":true}')
        );
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "crossOrigin true accepted"
        );

        signature.clientDataJSON =
            bytes.concat(bytes('{"challenge":"'), challenge, bytes('","origin":"'), origin, bytes('"}'));
        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "missing type field accepted"
        );
    }

    function testFuzz_WebAuthnAcceptsPermittedClientDataGrammar(
        uint8 fieldOrder,
        bool includeCrossOrigin,
        bool includeExtraField
    ) public {
        // MockP256Verifier always reports a valid signature, isolating clientDataJSON
        // parsing as the only thing that can make validateUserOp succeed.
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes32 hash = keccak256("fuzzed-user-operation");
        bytes memory origin = bytes("https://wallet.example");
        bytes memory clientDataJSON =
            _clientDataVariant(hash, origin, fieldOrder, includeCrossOrigin, includeExtraField);

        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: bytes.concat(keccak256("wallet.example"), hex"05"),
            clientDataJSON: clientDataJSON,
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    bytes32(uint256(1)),
                    bytes32(uint256(2)),
                    keccak256("wallet.example"),
                    keccak256(origin),
                    address(hook)
                )
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        uint256 result =
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0));
        require(result != ValidationDataLib.SIG_VALIDATION_FAILED, "permitted clientDataJSON grammar rejected");
    }

    function _clientDataVariant(
        bytes32 hash,
        bytes memory origin,
        uint8 fieldOrder,
        bool includeCrossOrigin,
        bool includeExtraField
    ) internal pure returns (bytes memory) {
        bytes memory typeField = bytes('"type":"webauthn.get"');
        bytes memory challengeField = bytes.concat(bytes('"challenge":"'), _base64Url(hash), bytes('"'));
        bytes memory originField = bytes.concat(bytes('"origin":"'), origin, bytes('"'));
        bytes memory requiredFields;

        uint8 order = fieldOrder % 6;
        if (order == 0) {
            requiredFields = bytes.concat(typeField, bytes(","), challengeField, bytes(","), originField);
        } else if (order == 1) {
            requiredFields = bytes.concat(typeField, bytes(","), originField, bytes(","), challengeField);
        } else if (order == 2) {
            requiredFields = bytes.concat(challengeField, bytes(","), typeField, bytes(","), originField);
        } else if (order == 3) {
            requiredFields = bytes.concat(challengeField, bytes(","), originField, bytes(","), typeField);
        } else if (order == 4) {
            requiredFields = bytes.concat(originField, bytes(","), typeField, bytes(","), challengeField);
        } else {
            requiredFields = bytes.concat(originField, bytes(","), challengeField, bytes(","), typeField);
        }

        bytes memory optionalFields;
        if (includeCrossOrigin) optionalFields = bytes(",\"crossOrigin\":false");
        if (includeExtraField) optionalFields = bytes.concat(optionalFields, bytes(",\"tokenBinding\":\"supported\""));
        return bytes.concat(bytes("{"), requiredFields, optionalFields, bytes("}"));
    }

    function testKeyRotationRequiresConfigTimelock() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes32 rpIdHash = keccak256("wallet.example");
        bytes32 originHash = keccak256("https://wallet.example");
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (bytes32(uint256(1)), bytes32(uint256(2)), rpIdHash, originHash, address(hook))
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        bytes memory setKey =
            abi.encodeCall(P256Validator.setKey, (bytes32(uint256(3)), bytes32(uint256(4)), rpIdHash, originHash));

        (bool immediate,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(validator), 0, setKey)))
                )
            );
        require(!immediate, "key rotation bypassed timelock");

        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, setKey, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, setKey);

        (bytes32 x, bytes32 y,,) = validator.publicKeys(address(account));
        require(x == bytes32(uint256(3)) && y == bytes32(uint256(4)), "key did not rotate");
        require(account.configVersion() == 2, "key rotation did not advance config");
    }

    function testP256DirectExecutionUsesTypedDigestAndPolicy() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes memory origin = bytes("https://wallet.example");
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    bytes32(uint256(1)),
                    bytes32(uint256(2)),
                    keccak256("wallet.example"),
                    keccak256(origin),
                    address(hook)
                )
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockTarget target = new MockTarget();
        bytes32 mode = account.SINGLE_EXECUTION_MODE();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (51))));
        uint48 validUntil = type(uint48).max;
        bytes32 digest = account.directExecutionDigest(address(validator), mode, executionCalldata, 0, validUntil);
        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: bytes.concat(keccak256("wallet.example"), hex"05"),
            clientDataJSON: bytes.concat(
                bytes('{"type":"webauthn.get","challenge":"'),
                _base64Url(digest),
                bytes('","origin":"'),
                origin,
                bytes('","crossOrigin":false}')
            ),
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        account.executeDirect(address(validator), mode, executionCalldata, validUntil, abi.encode(signature));

        require(target.value() == 51, "P-256 direct execution failed");
        require(account.directExecutionNonces(address(validator)) == 1, "P-256 direct nonce missing");
    }

    function testP256RejectsHashOnlyApprovalRemovedHookAndWrongModuleType() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        MockPolicyHook hook = new MockPolicyHook();
        bytes memory origin = bytes("https://wallet.example");
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    bytes32(uint256(1)),
                    bytes32(uint256(2)),
                    keccak256("wallet.example"),
                    keccak256(origin),
                    address(hook)
                )
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        bytes32 hash = keccak256("p256-removed-hook");
        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: bytes.concat(keccak256("wallet.example"), hex"05"),
            clientDataJSON: bytes.concat(
                bytes('{"type":"webauthn.get","challenge":"'),
                _base64Url(hash),
                bytes('","origin":"'),
                origin,
                bytes('","crossOrigin":false}')
            ),
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        require(
            !validator.isValidSignature(address(account), hash, abi.encode(signature)), "hash-only approval accepted"
        );
        require(validator.isModuleType(ModuleType.VALIDATOR), "validator module type rejected");
        require(!validator.isModuleType(ModuleType.HOOK), "hook module type accepted");

        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, uninstall);

        require(
            validator.validateUserOp(address(account), hash, 0, abi.encode(signature), bytes("call"), address(0))
                == ValidationDataLib.SIG_VALIDATION_FAILED,
            "removed hook accepted"
        );
    }

    function testP256DirectExecutionRejectsDeniedPolicyAndWrongSignature() public {
        MockP256Verifier verifier = new MockP256Verifier();
        P256Validator validator = new P256Validator(address(verifier));
        DenyPolicyHook denyHook = new DenyPolicyHook();
        bytes memory origin = bytes("https://wallet.example");
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(denyHook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    bytes32(uint256(1)),
                    bytes32(uint256(2)),
                    keccak256("wallet.example"),
                    keccak256(origin),
                    address(denyHook)
                )
            )
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockTarget target = new MockTarget();
        bytes32 mode = account.SINGLE_EXECUTION_MODE();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (53))));
        bytes32 digest = account.directExecutionDigest(address(validator), mode, executionCalldata, 0, type(uint48).max);
        P256Validator.WebAuthnSignature memory signature = P256Validator.WebAuthnSignature({
            authenticatorData: bytes.concat(keccak256("wallet.example"), hex"05"),
            clientDataJSON: bytes.concat(
                bytes('{"type":"webauthn.get","challenge":"'),
                _base64Url(digest),
                bytes('","origin":"'),
                origin,
                bytes('","crossOrigin":false}')
            ),
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });

        require(
            !validator.validateDirectExecution(address(account), digest, abi.encode(signature), executionCalldata),
            "denied policy accepted P-256 direct execution"
        );

        MockPolicyHook allowHook = new MockPolicyHook();
        bytes memory installHook = abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(allowHook), ""));
        _scheduleAndExecute(account, address(account), installHook);
        bytes memory setHook = abi.encodeCall(P256Validator.setPolicyHook, (address(allowHook)));
        _scheduleAndExecute(account, address(validator), setHook);
        signature.clientDataJSON = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            _base64Url(keccak256("wrong")),
            bytes('","origin":"'),
            origin,
            bytes('","crossOrigin":false}')
        );
        require(
            !validator.validateDirectExecution(address(account), digest, abi.encode(signature), executionCalldata),
            "wrong P-256 direct signature accepted"
        );
    }

    function _scheduleAndExecute(LoomAccount account, address target, bytes memory data) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(target, 0, data);
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
