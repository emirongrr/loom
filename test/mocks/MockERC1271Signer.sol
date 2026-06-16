// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC1271} from "../../src/interfaces/IERC1271.sol";

contract MockERC1271Signer is IERC1271 {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant INVALID_VALUE = 0xffffffff;

    bytes32 public acceptedHash;
    bytes public acceptedSignature;
    bool public shouldRevert;

    function setAccepted(bytes32 hash, bytes calldata signature) external {
        acceptedHash = hash;
        acceptedSignature = signature;
    }

    function setRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (shouldRevert) revert();
        return
            hash == acceptedHash && keccak256(signature) == keccak256(acceptedSignature) ? MAGIC_VALUE : INVALID_VALUE;
    }
}
