// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {WebAuthnP256} from "../libraries/WebAuthnP256.sol";

/// @notice Stateless guardian verifier for WebAuthn P-256 passkeys.
/// @dev The commitment is WebAuthnP256.fingerprint(publicKey).
contract P256GuardianVerifier is IGuardianVerifier {
    address public immutable fallbackVerifier;

    constructor(address fallbackVerifier_) {
        fallbackVerifier = fallbackVerifier_;
    }

    function verify(bytes32 keyCommitment, bytes32 digest, bytes calldata signature) external view returns (bool) {
        (WebAuthnP256.PublicKey memory key, WebAuthnP256.Signature memory webAuthn) =
            abi.decode(signature, (WebAuthnP256.PublicKey, WebAuthnP256.Signature));

        return
            keyCommitment == WebAuthnP256.fingerprint(key)
                && WebAuthnP256.verify(key, digest, webAuthn, fallbackVerifier);
    }
}
