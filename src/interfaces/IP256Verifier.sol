// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IP256Verifier {
    function verifySignatureAllowMalleability(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y)
        external
        view
        returns (bool);
}
