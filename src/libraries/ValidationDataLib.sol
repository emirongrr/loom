// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library ValidationDataLib {
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    function pack(bool signatureFailed, uint48 validUntil, uint48 validAfter) internal pure returns (uint256) {
        return (signatureFailed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }
}
