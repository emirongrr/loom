// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IP256Verifier} from "../../src/interfaces/IP256Verifier.sol";

contract MockP256Verifier is IP256Verifier {
    function verifySignatureAllowMalleability(bytes32, uint256, uint256, uint256, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
