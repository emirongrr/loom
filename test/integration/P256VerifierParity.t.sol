// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {WebAuthnP256} from "../../src/libraries/WebAuthnP256.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";

interface VmP256Parity {
    function mockCallRevert(address callee, bytes calldata data, bytes calldata revertData) external;
    function clearMockedCalls() external;
}

contract WebAuthnP256Harness {
    function verify(
        WebAuthnP256.PublicKey calldata key,
        bytes32 digest,
        WebAuthnP256.Signature calldata signature,
        address fallbackVerifier
    ) external view returns (bool) {
        return WebAuthnP256.verify(key, digest, signature, fallbackVerifier);
    }
}

contract P256VerifierParityTest {
    VmP256Parity internal constant vm = VmP256Parity(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant NATIVE_P256 = address(0x100);

    bytes32 internal constant DIGEST = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 internal constant PUBLIC_KEY_X = 0x8e533b6fa0bf7b4625bb30667c01fb607ef9f8b8a80fef5b300628703187b2a3;
    bytes32 internal constant PUBLIC_KEY_Y = 0x73eb1dbde03318366d069f83a6f5900053c73633cb041b21c55e1a86c1f400b4;
    bytes32 internal constant SIGNATURE_R = 0xdfc2f2a2b851e05ca7b33271d4cf248aad92928720c4ecee11e2ed1fa0304045;
    bytes32 internal constant SIGNATURE_S = 0x66ef1b01ff05d8d9aecbf4a8e50551b3c8e7bef80865c9bebcb05bf150ab2417;

    WebAuthnP256Harness internal harness;
    OZP256Verifier internal fallbackVerifier;

    function setUp() public {
        harness = new WebAuthnP256Harness();
        fallbackVerifier = new OZP256Verifier();
    }

    function testNativeAndFallbackAcceptTheSameReferenceAssertion() public {
        WebAuthnP256.PublicKey memory key = _key();
        WebAuthnP256.Signature memory signature = _signature();

        require(_native(key, DIGEST, signature), "native path rejected reference assertion");
        require(_fallback(key, DIGEST, signature), "fallback path rejected reference assertion");
    }

    function testNativeAndFallbackRejectTheSameMutations() public {
        WebAuthnP256.PublicKey memory key = _key();
        WebAuthnP256.Signature memory signature = _signature();

        _assertBothReject(key, keccak256("wrong digest"), signature);

        signature.r = bytes32(0);
        _assertBothReject(key, DIGEST, signature);

        signature = _signature();
        key.x = bytes32(uint256(key.x) + 1);
        _assertBothReject(key, DIGEST, signature);
    }

    function _assertBothReject(
        WebAuthnP256.PublicKey memory key,
        bytes32 digest,
        WebAuthnP256.Signature memory signature
    ) internal {
        require(!_native(key, digest, signature), "native path accepted mutated assertion");
        require(!_fallback(key, digest, signature), "fallback path accepted mutated assertion");
    }

    function _native(WebAuthnP256.PublicKey memory key, bytes32 digest, WebAuthnP256.Signature memory signature)
        internal
        returns (bool)
    {
        vm.clearMockedCalls();
        return harness.verify(key, digest, signature, address(fallbackVerifier));
    }

    function _fallback(WebAuthnP256.PublicKey memory key, bytes32 digest, WebAuthnP256.Signature memory signature)
        internal
        returns (bool)
    {
        bytes32 signedHash = sha256(bytes.concat(signature.authenticatorData, sha256(signature.clientDataJSON)));
        bytes memory nativeCall = abi.encode(signedHash, signature.r, signature.s, key.x, key.y);
        vm.mockCallRevert(NATIVE_P256, nativeCall, "native P-256 unavailable");
        bool valid = harness.verify(key, digest, signature, address(fallbackVerifier));
        vm.clearMockedCalls();
        return valid;
    }

    function _key() internal pure returns (WebAuthnP256.PublicKey memory) {
        return WebAuthnP256.PublicKey({
            x: PUBLIC_KEY_X,
            y: PUBLIC_KEY_Y,
            rpIdHash: 0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763,
            originHash: keccak256("http://localhost:8788")
        });
    }

    function _signature() internal pure returns (WebAuthnP256.Signature memory) {
        return WebAuthnP256.Signature({
            authenticatorData: hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000000",
            clientDataJSON: bytes(
                '{"type":"webauthn.get","challenge":"ERERERERERERERERERERERERERERERERERERERERERE","origin":"http://localhost:8788","crossOrigin":false}'
            ),
            origin: bytes("http://localhost:8788"),
            r: SIGNATURE_R,
            s: SIGNATURE_S
        });
    }
}
