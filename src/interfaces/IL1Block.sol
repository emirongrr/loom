// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Minimal interface for the OP Stack `L1Block` predeploy
/// (canonical address `0x4200000000000000000000000000000000000015`). The
/// predeploy is written by the OP Stack sequencer each L2 block and exposes
/// attributes of the most recently committed Ethereum L1 block.
/// @dev Every function declared here exists on the canonical predeploy. It does
/// **not** expose the L1 state root; the attributes it carries are the block
/// hash, number, timestamp, and fee parameters. A verifier that needs the state
/// root must prove an L1 block header preimage against `hash()` and read the
/// state root out of that header.
///
/// An earlier version of this interface declared a `stateRoot()` function that
/// the predeploy does not have. Because the predeploy has no fallback, calling
/// it reverted on every real OP Stack chain, so the verifier built on it could
/// never accept a proof. The mistake survived because the unit test supplied a
/// mock that implemented the imagined function.
interface IL1Block {
    /// @notice Block hash of the most recently committed Ethereum L1 block.
    function hash() external view returns (bytes32);

    /// @notice Block number of the most recently committed Ethereum L1 block.
    function number() external view returns (uint64);

    /// @notice Block timestamp of the most recently committed Ethereum L1 block.
    function timestamp() external view returns (uint64);
}
