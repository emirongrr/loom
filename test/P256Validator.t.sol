// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "../src/validators/P256Validator.sol";
import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../src/libraries/ValidationDataLib.sol";
import {MockP256Verifier} from "./mocks/MockP256Verifier.sol";
import {MockPolicyHook} from "./mocks/MockPolicyHook.sol";

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
