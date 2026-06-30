// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Minimal interface for the OP Stack `L1Block` predeploy
/// (canonical address `0x4200000000000000000000000000000000000015`). The
/// predeploy is written by the OP Stack sequencer each L2 block and exposes
/// attributes of the most recently committed Ethereum L1 block. Only
/// `stateRoot()` is needed to verify EIP-1186 L1 storage proofs on the L2.
interface IL1Block {
    /// @notice The Ethereum L1 state root of the most recently committed L1 block.
    function stateRoot() external view returns (bytes32);
}
