// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IP256Verifier} from "../interfaces/IP256Verifier.sol";
import {Base64Url} from "./Base64Url.sol";

library WebAuthnP256 {
    uint256 internal constant MAX_AUTHENTICATOR_DATA_LENGTH = 1024;
    uint256 internal constant MAX_CLIENT_DATA_JSON_LENGTH = 1024;
    uint256 internal constant MAX_ORIGIN_LENGTH = 256;
    uint256 internal constant P256_HALF_ORDER = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    struct PublicKey {
        bytes32 x;
        bytes32 y;
        bytes32 rpIdHash;
        bytes32 originHash;
    }

    struct Signature {
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes origin;
        bytes32 r;
        bytes32 s;
    }

    function isValidKey(PublicKey memory key) internal pure returns (bool) {
        return key.x != bytes32(0) && key.y != bytes32(0) && key.rpIdHash != bytes32(0) && key.originHash != bytes32(0);
    }

    // Excludes rpIdHash/originHash: the same physical authenticator registered
    // under a different origin must still dedupe to one credential, or a
    // multi-credential threshold could be satisfied by a single device.
    function fingerprint(PublicKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key.x, key.y));
    }

    function verify(PublicKey memory key, bytes32 hash, Signature memory webAuthn, address fallbackVerifier)
        internal
        view
        returns (bool)
    {
        if (
            webAuthn.authenticatorData.length < 33 || webAuthn.authenticatorData.length > MAX_AUTHENTICATOR_DATA_LENGTH
                || webAuthn.clientDataJSON.length > MAX_CLIENT_DATA_JSON_LENGTH
                || webAuthn.origin.length > MAX_ORIGIN_LENGTH
        ) return false;
        if (webAuthn.r == bytes32(0) || webAuthn.s == bytes32(0) || uint256(webAuthn.s) > P256_HALF_ORDER) {
            return false;
        }

        bytes32 receivedRpIdHash;
        bytes memory authenticatorData = webAuthn.authenticatorData;
        assembly {
            receivedRpIdHash := mload(add(authenticatorData, 32))
        }
        if (!isValidKey(key) || receivedRpIdHash != key.rpIdHash) return false;

        uint8 flags = uint8(webAuthn.authenticatorData[32]);
        if ((flags & 0x05) != 0x05) return false;
        if (keccak256(webAuthn.origin) != key.originHash) return false;

        bytes memory expectedClientData = bytes.concat(
            bytes('{"type":"webauthn.get","challenge":"'),
            Base64Url.encode32(hash),
            bytes('","origin":"'),
            webAuthn.origin,
            bytes('","crossOrigin":false}')
        );
        if (keccak256(webAuthn.clientDataJSON) != keccak256(expectedClientData)) return false;

        bytes32 signedHash = sha256(bytes.concat(webAuthn.authenticatorData, sha256(webAuthn.clientDataJSON)));
        (bool ok, bytes memory result) =
            address(0x100).staticcall(abi.encode(signedHash, webAuthn.r, webAuthn.s, key.x, key.y));
        if (ok && result.length == 32) return abi.decode(result, (uint256)) == 1;
        if (fallbackVerifier == address(0)) return false;
        return IP256Verifier(fallbackVerifier)
            .verifySignatureAllowMalleability(
                signedHash, uint256(webAuthn.r), uint256(webAuthn.s), uint256(key.x), uint256(key.y)
            );
    }
}
