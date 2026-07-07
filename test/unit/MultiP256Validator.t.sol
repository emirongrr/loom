// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {MultiP256Validator} from "../../src/validators/MultiP256Validator.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {WebAuthnP256} from "../../src/libraries/WebAuthnP256.sol";
import {MockP256Verifier} from "../mocks/MockP256Verifier.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {DenyPolicyHook} from "../mocks/DenyPolicyHook.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmMultiP256 {
    function warp(uint256) external;
    function pauseGasMetering() external;
    function resumeGasMetering() external;
}

contract MultiP256ValidatorTest {
    VmMultiP256 internal constant vm = VmMultiP256(address(uint160(uint256(keccak256("hevm cheat code")))));

    MultiP256Validator internal validator;
    MockPolicyHook internal hook;
    LoomAccount internal account;

    bytes32 internal constant ID_ONE = bytes32(uint256(1));
    bytes32 internal constant ID_TWO = bytes32(uint256(2));
    bytes32 internal constant ID_THREE = bytes32(uint256(3));

    function setUp() public {
        validator = new MultiP256Validator(address(new MockP256Verifier()));
        hook = new MockPolicyHook();
        MultiP256Validator.CredentialInit[] memory initial = new MultiP256Validator.CredentialInit[](2);
        initial[0] = MultiP256Validator.CredentialInit(ID_ONE, _key(1));
        initial[1] = MultiP256Validator.CredentialInit(ID_TWO, _key(2));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(MultiP256Validator.initialize, (initial, 2, address(hook)))
        );
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testThresholdRequiresDistinctSortedCredentials() public {
        // Foundry's gas result changes with the warm/cold state of the P-256
        // precompile across suites. This is a behavior test, not a benchmark.
        vm.pauseGasMetering();
        bytes32 hash = keccak256("user-operation");
        MultiP256Validator.CredentialSignature[] memory valid = new MultiP256Validator.CredentialSignature[](2);
        valid[0] = MultiP256Validator.CredentialSignature(ID_ONE, _signature(hash, 1));
        valid[1] = MultiP256Validator.CredentialSignature(ID_TWO, _signature(hash, 2));
        require(_validate(hash, valid) != ValidationDataLib.SIG_VALIDATION_FAILED, "valid threshold rejected");

        MultiP256Validator.CredentialSignature[] memory one = new MultiP256Validator.CredentialSignature[](1);
        one[0] = valid[0];
        require(_validate(hash, one) == ValidationDataLib.SIG_VALIDATION_FAILED, "sub-threshold accepted");

        MultiP256Validator.CredentialSignature[] memory duplicate = new MultiP256Validator.CredentialSignature[](2);
        duplicate[0] = valid[0];
        duplicate[1] = valid[0];
        require(_validate(hash, duplicate) == ValidationDataLib.SIG_VALIDATION_FAILED, "duplicate accepted");

        MultiP256Validator.CredentialSignature[] memory unsorted = new MultiP256Validator.CredentialSignature[](2);
        unsorted[0] = valid[1];
        unsorted[1] = valid[0];
        require(_validate(hash, unsorted) == ValidationDataLib.SIG_VALIDATION_FAILED, "unsorted accepted");
        vm.resumeGasMetering();
    }

    function testCredentialAndThresholdLifecycleRequiresTimelock() public {
        WebAuthnP256.PublicKey memory third = _key(3);
        bytes memory add = abi.encodeCall(MultiP256Validator.addCredential, (ID_THREE, third));
        (bool direct,) = address(validator).call(add);
        require(!direct, "direct credential add accepted");

        _scheduleAndExecute(address(validator), add);
        require(validator.credentialCount(address(account)) == 3, "credential not added");
        require(account.configVersion() == 2, "add did not advance config");

        bytes memory threshold = abi.encodeCall(MultiP256Validator.setThreshold, (uint8(3)));
        _scheduleAndExecute(address(validator), threshold);
        require(validator.thresholds(address(account)) == 3, "threshold not updated");

        bytes memory remove = abi.encodeCall(MultiP256Validator.removeCredential, (ID_THREE));
        _schedule(account, address(validator), remove);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool belowThreshold,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, remove)));
        require(!belowThreshold, "credential removed below threshold");

        bytes memory lowerThreshold = abi.encodeCall(MultiP256Validator.setThreshold, (uint8(2)));
        _scheduleAndExecute(address(validator), lowerThreshold);
        _scheduleAndExecute(address(validator), remove);
        require(validator.credentialCount(address(account)) == 2, "credential not removed");

        _scheduleAndExecute(address(validator), add);
        require(validator.credentialCount(address(account)) == 3, "removed credential key could not be re-added");
    }

    function testDuplicatePublicKeyCannotSatisfyThreshold() public {
        bytes memory duplicateKey = abi.encodeCall(MultiP256Validator.addCredential, (ID_THREE, _key(1)));
        _schedule(account, address(validator), duplicateKey);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool duplicate,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, duplicateKey)));
        require(!duplicate, "duplicate public key accepted");

        bytes memory duplicateId = abi.encodeCall(MultiP256Validator.addCredential, (ID_ONE, _key(3)));
        _schedule(account, address(validator), duplicateId);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (duplicate,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, duplicateId)));
        require(!duplicate, "duplicate credential id accepted");
    }

    function testSameKeyDifferentOriginCannotOccupySeparateCredentialSlot() public {
        WebAuthnP256.PublicKey memory sameKeyOtherOrigin = WebAuthnP256.PublicKey(
            _key(1).x,
            _key(1).y,
            keccak256(abi.encode("attacker.example", uint256(1))),
            keccak256(bytes("https://attacker.example"))
        );
        bytes memory add = abi.encodeCall(MultiP256Validator.addCredential, (ID_THREE, sameKeyOtherOrigin));
        _schedule(account, address(validator), add);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool accepted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, add)));
        require(!accepted, "same physical key accepted under a different origin/rpId fingerprint");
    }

    function testInvalidThresholdAndUnknownRemovalRejected() public {
        bytes memory zeroThreshold = abi.encodeCall(MultiP256Validator.setThreshold, (uint8(0)));
        _schedule(account, address(validator), zeroThreshold);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool invalid,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, zeroThreshold)));
        require(!invalid, "zero threshold accepted");

        bytes memory tooHighThreshold = abi.encodeCall(MultiP256Validator.setThreshold, (uint8(3)));
        _schedule(account, address(validator), tooHighThreshold);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (invalid,) = address(account)
            .call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, tooHighThreshold)));
        require(!invalid, "threshold above credential count accepted");

        bytes memory unknownRemoval = abi.encodeCall(MultiP256Validator.removeCredential, (ID_THREE));
        _schedule(account, address(validator), unknownRemoval);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (invalid,) = address(account)
            .call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, unknownRemoval)));
        require(!invalid, "unknown credential removed");
    }

    function testUnknownCredentialAndWrongChallengeRejected() public view {
        bytes32 hash = keccak256("user-operation");
        MultiP256Validator.CredentialSignature[] memory signatures = new MultiP256Validator.CredentialSignature[](2);
        signatures[0] = MultiP256Validator.CredentialSignature(ID_ONE, _signature(hash, 1));
        signatures[1] = MultiP256Validator.CredentialSignature(ID_THREE, _signature(hash, 3));
        require(_validate(hash, signatures) == ValidationDataLib.SIG_VALIDATION_FAILED, "unknown credential accepted");

        signatures[1] = MultiP256Validator.CredentialSignature(ID_TWO, _signature(keccak256("wrong"), 2));
        require(_validate(hash, signatures) == ValidationDataLib.SIG_VALIDATION_FAILED, "wrong challenge accepted");
    }

    function testMfaRejectsArbitraryErc1271() public view {
        require(
            !validator.isValidSignature(address(account), keccak256("message"), ""),
            "MFA validator authorized arbitrary hash"
        );
        require(validator.isModuleType(ModuleType.VALIDATOR), "validator module type rejected");
        require(!validator.isModuleType(ModuleType.HOOK), "hook module type accepted");
    }

    function testMfaValidationDoesNotReadPolicyButDirectExecutionDoes() public {
        DenyPolicyHook denyHook = new DenyPolicyHook();
        MultiP256Validator deniedValidator = new MultiP256Validator(address(new MockP256Verifier()));
        MultiP256Validator.CredentialInit[] memory initial = new MultiP256Validator.CredentialInit[](2);
        initial[0] = MultiP256Validator.CredentialInit(ID_ONE, _key(1));
        initial[1] = MultiP256Validator.CredentialInit(ID_TWO, _key(2));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(denyHook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(deniedValidator),
            abi.encodeCall(MultiP256Validator.initialize, (initial, 2, address(denyHook)))
        );
        LoomAccount deniedAccount =
            new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        bytes32 hash = keccak256("user-operation");
        MultiP256Validator.CredentialSignature[] memory signatures = new MultiP256Validator.CredentialSignature[](2);
        signatures[0] = MultiP256Validator.CredentialSignature(ID_ONE, _signature(hash, 1));
        signatures[1] = MultiP256Validator.CredentialSignature(ID_TWO, _signature(hash, 2));
        require(
            deniedValidator.validateUserOp(
                address(deniedAccount), hash, 0, abi.encode(signatures), bytes("call"), address(0)
            ) == 0,
            "validation read low-risk policy"
        );

        MockTarget target = new MockTarget();
        bytes32 mode = deniedAccount.SINGLE_EXECUTION_MODE();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1))));
        bytes32 executionHash =
            deniedAccount.directExecutionDigest(address(deniedValidator), mode, executionCalldata, 0, type(uint48).max);
        signatures[0] = MultiP256Validator.CredentialSignature(ID_ONE, _signature(executionHash, 1));
        signatures[1] = MultiP256Validator.CredentialSignature(ID_TWO, _signature(executionHash, 2));
        require(
            !deniedValidator.validateDirectExecution(
                address(deniedAccount), executionHash, abi.encode(signatures), executionCalldata
            ),
            "direct execution bypassed low-risk policy"
        );
    }

    function testPolicyHookLifecycleRejectsInvalidAndAcceptsInstalledHook() public {
        bytes memory zeroHook = abi.encodeCall(MultiP256Validator.setPolicyHook, (address(0)));
        _schedule(account, address(validator), zeroHook);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool invalid,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, zeroHook)));
        require(!invalid, "zero policy hook accepted");

        MockPolicyHook replacement = new MockPolicyHook();
        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(replacement), ""));
        _scheduleAndExecute(address(account), install);
        bytes memory setHook = abi.encodeCall(MultiP256Validator.setPolicyHook, (address(replacement)));
        _scheduleAndExecute(address(validator), setHook);
        require(validator.policyHooks(address(account)) == address(replacement), "policy hook not updated");
    }

    function testMfaDirectExecutionRequiresThreshold() public {
        MockTarget target = new MockTarget();
        bytes32 mode = account.SINGLE_EXECUTION_MODE();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (52))));
        uint48 validUntil = type(uint48).max;
        bytes32 digest = account.directExecutionDigest(address(validator), mode, executionCalldata, 0, validUntil);
        MultiP256Validator.CredentialSignature[] memory signatures = new MultiP256Validator.CredentialSignature[](2);
        signatures[0] = MultiP256Validator.CredentialSignature(ID_ONE, _signature(digest, 1));
        signatures[1] = MultiP256Validator.CredentialSignature(ID_TWO, _signature(digest, 2));

        account.executeDirect(address(validator), mode, executionCalldata, validUntil, abi.encode(signatures));

        require(target.value() == 52, "MFA direct execution failed");
        require(account.directExecutionNonces(address(validator)) == 1, "MFA direct nonce missing");
    }

    function _validate(bytes32 hash, MultiP256Validator.CredentialSignature[] memory signatures)
        internal
        view
        returns (uint256)
    {
        return validator.validateUserOp(address(account), hash, 0, abi.encode(signatures), bytes("call"), address(0));
    }

    function _key(uint256 seed) internal pure returns (WebAuthnP256.PublicKey memory) {
        bytes memory origin = bytes("https://wallet.example");
        return WebAuthnP256.PublicKey(
            bytes32(seed), bytes32(seed + 100), keccak256(abi.encode("wallet.example", seed)), keccak256(origin)
        );
    }

    function _signature(bytes32 hash, uint256 seed) internal pure returns (WebAuthnP256.Signature memory) {
        bytes memory origin = bytes("https://wallet.example");
        bytes memory clientData = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            _base64Url(hash),
            bytes('","origin":"'),
            origin,
            bytes('","crossOrigin":false}')
        );
        return WebAuthnP256.Signature({
            authenticatorData: bytes.concat(keccak256(abi.encode("wallet.example", seed)), hex"05"),
            clientDataJSON: clientData,
            origin: origin,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1))
        });
    }

    function _scheduleAndExecute(address target, bytes memory data) internal {
        _schedule(account, target, data);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(target, 0, data);
    }

    function _schedule(LoomAccount targetAccount, address target, bytes memory data) internal {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, targetAccount.MIN_CONFIG_DELAY()));
        targetAccount.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(targetAccount), 0, schedule)));
    }

    function _base64Url(bytes32 input) internal pure returns (bytes memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory output = new bytes(43);
        bytes memory raw = abi.encodePacked(input);
        uint256 outIndex = 0;
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
