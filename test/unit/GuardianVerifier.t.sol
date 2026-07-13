// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC1271GuardianVerifier} from "../../src/recovery/ERC1271GuardianVerifier.sol";
import {P256GuardianVerifier} from "../../src/recovery/P256GuardianVerifier.sol";
import {WebAuthnP256} from "../../src/libraries/WebAuthnP256.sol";
import {MockERC1271Signer} from "../mocks/MockERC1271Signer.sol";
import {MockP256Verifier} from "../mocks/MockP256Verifier.sol";
import {P256TestKeys} from "../helpers/P256TestKeys.sol";

contract GuardianVerifierTest {
    function testP256GuardianVerifierBindsPublicKeyCommitmentAndWebAuthnFields() public {
        P256GuardianVerifier verifier = new P256GuardianVerifier(address(new MockP256Verifier()));
        bytes32 digest = keccak256("recovery");
        WebAuthnP256.PublicKey memory key = _key();
        WebAuthnP256.Signature memory signature = _signature(digest);
        bytes32 commitment = WebAuthnP256.fingerprint(key);

        require(verifier.verify(commitment, digest, abi.encode(key, signature)), "valid passkey guardian rejected");
        require(
            !verifier.verify(keccak256("wrong"), digest, abi.encode(key, signature)),
            "wrong passkey commitment accepted"
        );

        signature.origin = bytes("https://evil.example");
        require(!verifier.verify(commitment, digest, abi.encode(key, signature)), "wrong origin accepted");
    }

    function testERC1271GuardianVerifierBindsContractCommitmentAndMagicValue() public {
        ERC1271GuardianVerifier verifier = new ERC1271GuardianVerifier();
        MockERC1271Signer signer = new MockERC1271Signer();
        bytes32 digest = keccak256("recovery");
        bytes memory signerSignature = hex"cafe";
        bytes32 commitment = keccak256(abi.encode(address(signer)));
        signer.setAccepted(digest, signerSignature);

        require(
            verifier.verify(commitment, digest, abi.encode(address(signer), signerSignature)),
            "valid ERC-1271 guardian rejected"
        );
        require(
            !verifier.verify(keccak256("wrong"), digest, abi.encode(address(signer), signerSignature)),
            "wrong ERC-1271 commitment accepted"
        );
        require(
            !verifier.verify(commitment, digest, abi.encode(address(signer), hex"dead")),
            "invalid ERC-1271 signature accepted"
        );
        require(
            !verifier.verify(
                keccak256(abi.encode(address(0xBEEF))), digest, abi.encode(address(0xBEEF), signerSignature)
            ),
            "EOA-like guardian accepted"
        );

        signer.setRevert(true);
        require(
            !verifier.verify(commitment, digest, abi.encode(address(signer), signerSignature)),
            "reverting ERC-1271 guardian accepted"
        );
    }

    function _key() internal pure returns (WebAuthnP256.PublicKey memory) {
        return WebAuthnP256.PublicKey(
            P256TestKeys.x(1),
            P256TestKeys.y(1),
            keccak256("wallet.example"),
            keccak256(bytes("https://wallet.example"))
        );
    }

    function _signature(bytes32 digest) internal pure returns (WebAuthnP256.Signature memory) {
        bytes memory origin = bytes("https://wallet.example");
        return WebAuthnP256.Signature({
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
