// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {ECDSA} from "../libraries/ECDSA.sol";

/// @notice Stateless guardian verifier for address-backed commitments.
/// @dev The commitment is keccak256(abi.encode(guardian)).
contract ECDSAGuardianVerifier is IGuardianVerifier {
    function verify(bytes32 keyCommitment, bytes32 digest, bytes calldata signature) external pure returns (bool) {
        address signer = ECDSA.recover(digest, signature);
        return signer != address(0) && keyCommitment == keccak256(abi.encode(signer));
    }
}
