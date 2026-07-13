// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library P256TestKeys {
    function x(uint256 index) internal pure returns (bytes32 value) {
        (value,) = point(index);
    }

    function y(uint256 index) internal pure returns (bytes32 value) {
        (, value) = point(index);
    }

    function point(uint256 index) internal pure returns (bytes32 xCoordinate, bytes32 yCoordinate) {
        if (index == 1) {
            return (
                0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
                0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5
            );
        }
        if (index == 2) {
            return (
                0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978,
                0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1
            );
        }
        if (index == 3) {
            return (
                0x5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c,
                0x8734640c4998ff7e374b06ce1a64a2ecd82ab036384fb83d9a79b127a27d5032
            );
        }
        revert("unsupported P-256 test point");
    }
}
