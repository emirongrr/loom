// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {IP256Verifier} from "../../src/interfaces/IP256Verifier.sol";

contract OZP256Verifier is IP256Verifier {
    function verifySignatureAllowMalleability(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y)
        external
        view
        returns (bool)
    {
        return P256.verifySolidity(hash, bytes32(r), bytes32(s), bytes32(x), bytes32(y));
    }
}
