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

        if (!_clientDataMatches(webAuthn.clientDataJSON, Base64Url.encode32(hash), webAuthn.origin)) return false;

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

    // Authenticators may emit extra top-level fields (e.g. tokenBinding) or
    // reorder crossOrigin/origin; the W3C spec only requires type, challenge,
    // and origin. Each required key must appear exactly once with the exact
    // expected value, so an authenticator cannot satisfy this check without
    // having actually signed over the expected challenge and origin.
    function _clientDataMatches(bytes memory clientDataJSON, bytes memory expectedChallenge, bytes memory origin)
        private
        pure
        returns (bool)
    {
        uint256 end = clientDataJSON.length;
        if (end < 2 || clientDataJSON[0] != "{" || clientDataJSON[end - 1] != "}") return false;
        end -= 1;

        bool sawType;
        bool sawChallenge;
        bool sawOrigin;
        bool sawCrossOrigin;

        uint256 i = 1;
        while (i < end) {
            if (clientDataJSON[i] != '"') return false;
            (bool keyOk, bytes memory key, uint256 afterKey) = _readQuotedString(clientDataJSON, i, end);
            if (!keyOk || afterKey >= end || clientDataJSON[afterKey] != ":") return false;

            uint256 valueStart = afterKey + 1;
            bytes memory value;
            uint256 afterValue;
            if (valueStart < end && clientDataJSON[valueStart] == '"') {
                bool valueOk;
                (valueOk, value, afterValue) = _readQuotedString(clientDataJSON, valueStart, end);
                if (!valueOk) return false;
            } else {
                uint256 j = valueStart;
                while (j < end && clientDataJSON[j] != ",") {
                    ++j;
                }
                value = _slice(clientDataJSON, valueStart, j);
                afterValue = j;
            }

            bytes32 keyHash = keccak256(key);
            if (keyHash == keccak256(bytes("type"))) {
                if (sawType || keccak256(value) != keccak256(bytes("webauthn.get"))) return false;
                sawType = true;
            } else if (keyHash == keccak256(bytes("challenge"))) {
                if (sawChallenge || keccak256(value) != keccak256(expectedChallenge)) return false;
                sawChallenge = true;
            } else if (keyHash == keccak256(bytes("origin"))) {
                if (sawOrigin || keccak256(value) != keccak256(origin)) return false;
                sawOrigin = true;
            } else if (keyHash == keccak256(bytes("crossOrigin"))) {
                if (sawCrossOrigin || keccak256(value) != keccak256(bytes("false"))) return false;
                sawCrossOrigin = true;
            }

            if (afterValue == end) {
                i = end;
                break;
            }
            if (clientDataJSON[afterValue] != ",") return false;
            i = afterValue + 1;
        }

        return i == end && sawType && sawChallenge && sawOrigin;
    }

    function _readQuotedString(bytes memory data, uint256 start, uint256 end)
        private
        pure
        returns (bool ok, bytes memory value, uint256 afterEnd)
    {
        uint256 i = start + 1;
        while (i < end) {
            if (data[i] == "\\") {
                i += 2;
                continue;
            }
            if (data[i] == '"') {
                return (true, _slice(data, start + 1, i), i + 1);
            }
            ++i;
        }
        return (false, value, afterEnd);
    }

    function _slice(bytes memory data, uint256 start, uint256 end) private pure returns (bytes memory) {
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = data[i];
        }
        return out;
    }
}
