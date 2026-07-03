// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Shared EIP-712 domain plumbing for every Loom contract that signs
/// or verifies typed data.
/// @dev Each contract keeps its own name and version hashes; only the domain
/// typehash and the separator/digest construction are shared, so all signing
/// domains are guaranteed to be built the same way.
library EIP712Lib {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Bound to the calling contract: internal library calls run in the
    /// caller's context, so address(this) is the verifying contract.
    function domainSeparator(bytes32 nameHash, bytes32 versionHash) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, address(this)));
    }

    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }
}
