// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";

interface VmWebAuthnFixture {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
}

contract WebAuthnFixtureCorpusTest {
    VmWebAuthnFixture internal constant vm = VmWebAuthnFixture(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant REFERENCE_FIXTURE = "fixtures/webauthn/reference/node-p256.json";
    string internal constant BRAVE_WINDOWS_HELLO_FIXTURE = "fixtures/webauthn/corpus/brave-windows-hello.json";
    string internal constant CHROME_WINDOWS_HELLO_FIXTURE = "fixtures/webauthn/corpus/chrome-windows-hello.json";
    string internal constant EDGE_WINDOWS_HELLO_FIXTURE = "fixtures/webauthn/corpus/edge-windows-hello.json";

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

    function testReferenceFixtureVerifiesThroughP256Validator() public {
        _assertFixtureVerifies(REFERENCE_FIXTURE, "reference fixture rejected");
    }

    function testBraveWindowsHelloCorpusFixtureVerifiesThroughP256Validator() public {
        _assertFixtureVerifies(BRAVE_WINDOWS_HELLO_FIXTURE, "brave windows hello fixture rejected");
    }

    function testChromeWindowsHelloCorpusFixtureVerifiesThroughP256Validator() public {
        _assertFixtureVerifies(CHROME_WINDOWS_HELLO_FIXTURE, "chrome windows hello fixture rejected");
    }

    function testEdgeWindowsHelloCorpusFixtureVerifiesThroughP256Validator() public {
        _assertFixtureVerifies(EDGE_WINDOWS_HELLO_FIXTURE, "edge windows hello fixture rejected");
    }

    function testReferenceFixtureNegativeMutationsFailClosed() public {
        _assertFixtureMutationsFailClosed(REFERENCE_FIXTURE);
    }

    function testBraveWindowsHelloCorpusFixtureNegativeMutationsFailClosed() public {
        _assertFixtureMutationsFailClosed(BRAVE_WINDOWS_HELLO_FIXTURE);
    }

    function testChromeWindowsHelloCorpusFixtureNegativeMutationsFailClosed() public {
        _assertFixtureMutationsFailClosed(CHROME_WINDOWS_HELLO_FIXTURE);
    }

    function testEdgeWindowsHelloCorpusFixtureNegativeMutationsFailClosed() public {
        _assertFixtureMutationsFailClosed(EDGE_WINDOWS_HELLO_FIXTURE);
    }

    function _assertFixtureVerifies(string memory path, string memory message) internal {
        (P256Validator validator, LoomAccount account, Fixture memory fixture) = _validatorFromFixture(path);
        require(
            validator.validateUserOp(
                address(account), fixture.challenge, 0, abi.encode(_signature(fixture)), bytes("call"), address(0)
            ) != ValidationDataLib.SIG_VALIDATION_FAILED,
            message
        );
    }

    function _assertFixtureMutationsFailClosed(string memory path) internal {
        (P256Validator validator, LoomAccount account, Fixture memory fixture) = _validatorFromFixture(path);

        Fixture memory wrongChallenge = fixture;
        wrongChallenge.challenge = keccak256("wrong challenge");
        _assertRejected(validator, account, wrongChallenge, "wrong challenge accepted");

        Fixture memory wrongOrigin = fixture;
        wrongOrigin.origin = bytes("http://evil.localhost");
        _assertRejected(validator, account, wrongOrigin, "wrong origin accepted");

        Fixture memory wrongRpIdHash = fixture;
        wrongRpIdHash.authenticatorData[0] = bytes1(uint8(wrongRpIdHash.authenticatorData[0]) ^ 0x01);
        _assertRejected(validator, account, wrongRpIdHash, "wrong rpId hash accepted");

        Fixture memory missingUv = fixture;
        missingUv.authenticatorData[32] = bytes1(uint8(missingUv.authenticatorData[32]) & 0xfb);
        _assertRejected(validator, account, missingUv, "missing uv accepted");

        Fixture memory badSignature = fixture;
        badSignature.r = bytes32(uint256(badSignature.r) ^ 1);
        _assertRejected(validator, account, badSignature, "bad signature accepted");

        Fixture memory oversized = fixture;
        oversized.clientDataJSON = new bytes(1025);
        _assertRejected(validator, account, oversized, "oversized payload accepted");
    }

    function _assertRejected(
        P256Validator validator,
        LoomAccount account,
        Fixture memory fixture,
        string memory message
    ) internal view {
        require(
            validator.validateUserOp(
                address(account), fixture.challenge, 0, abi.encode(_signature(fixture)), bytes("call"), address(0)
            ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            message
        );
    }

    function _validatorFromFixture(string memory path)
        internal
        returns (P256Validator validator, LoomAccount account, Fixture memory f)
    {
        f = _loadFixture(path);
        MockPolicyHook hook = new MockPolicyHook();
        validator = new P256Validator(address(new OZP256Verifier()));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(
                P256Validator.initialize,
                (f.publicKeyX, f.publicKeyY, _rpIdHash(f.authenticatorData), keccak256(f.origin), address(hook))
            )
        );
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
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

    function _signature(Fixture memory f) internal pure returns (P256Validator.WebAuthnSignature memory) {
        return P256Validator.WebAuthnSignature({
            authenticatorData: f.authenticatorData, clientDataJSON: f.clientDataJSON, origin: f.origin, r: f.r, s: f.s
        });
    }

    function _rpIdHash(bytes memory authenticatorData) internal pure returns (bytes32 rpIdHash) {
        assembly {
            rpIdHash := mload(add(authenticatorData, 32))
        }
    }
}
