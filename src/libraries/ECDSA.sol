// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library ECDSA {
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function recover(bytes32 hash, bytes memory signature) internal pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (uint256(s) > HALF_ORDER) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        signer = ecrecover(hash, v, r, s);
    }
}
