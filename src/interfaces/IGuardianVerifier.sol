// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IGuardianVerifier {
    function verify(bytes32 keyCommitment, bytes32 digest, bytes calldata signature) external view returns (bool);
}
