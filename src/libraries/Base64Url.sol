// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library Base64Url {
    bytes internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    function encode32(bytes32 input) internal pure returns (bytes memory output) {
        output = new bytes(43);
        bytes memory raw = abi.encodePacked(input);
        uint256 outIndex = 0;
        for (uint256 i; i < 32; i += 3) {
            uint256 remaining = 32 - i;
            uint24 chunk = uint24(uint8(raw[i])) << 16;
            if (remaining > 1) chunk |= uint24(uint8(raw[i + 1])) << 8;
            if (remaining > 2) chunk |= uint24(uint8(raw[i + 2]));

            output[outIndex++] = TABLE[(chunk >> 18) & 0x3f];
            output[outIndex++] = TABLE[(chunk >> 12) & 0x3f];
            if (remaining > 1) output[outIndex++] = TABLE[(chunk >> 6) & 0x3f];
            if (remaining > 2) output[outIndex++] = TABLE[chunk & 0x3f];
        }
    }
}
