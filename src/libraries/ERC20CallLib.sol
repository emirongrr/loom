// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Shared parser for the ERC-20 call shapes that Loom policy code
/// inspects: transfer, transferFrom, and approve.
/// @dev Policy hooks and session validators must all read the same fields from
/// the same offsets; a divergence between hand-rolled copies would let one
/// enforcement layer meter a different amount or counterparty than another.
/// Length checks are strict: a token selector with non-canonical calldata is
/// reported as unparsed, and each caller maps that to its own fail-closed
/// behavior (reject, or meter as an unbounded spend).
library ERC20CallLib {
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant APPROVE = 0x095ea7b3;

    function selector(bytes memory callData) internal pure returns (bytes4 result) {
        if (callData.length < 4) return bytes4(0);
        assembly {
            result := mload(add(callData, 32))
        }
    }

    function isTokenSelector(bytes4 callSelector) internal pure returns (bool) {
        return callSelector == TRANSFER || callSelector == TRANSFER_FROM || callSelector == APPROVE;
    }

    /// @dev Decodes a token call into (from, to, amount).
    /// transfer(to, amount) and approve(spender, amount): `to` is the recipient
    /// or spender and `from` is zero. transferFrom(from, to, amount) fills all
    /// three. `parsed` is false for non-token selectors and for token selectors
    /// whose calldata length is not the canonical ABI encoding.
    function decodeTokenCall(bytes memory callData)
        internal
        pure
        returns (bool parsed, address from, address to, uint256 amount)
    {
        bytes4 callSelector = selector(callData);
        if (callSelector == TRANSFER || callSelector == APPROVE) {
            if (callData.length != 68) return (false, address(0), address(0), 0);
            assembly {
                to := mload(add(callData, 36))
                amount := mload(add(callData, 68))
            }
            return (true, address(0), to, amount);
        }
        if (callSelector == TRANSFER_FROM) {
            if (callData.length != 100) return (false, address(0), address(0), 0);
            assembly {
                from := mload(add(callData, 36))
                to := mload(add(callData, 68))
                amount := mload(add(callData, 100))
            }
            return (true, from, to, amount);
        }
        return (false, address(0), address(0), 0);
    }
}
