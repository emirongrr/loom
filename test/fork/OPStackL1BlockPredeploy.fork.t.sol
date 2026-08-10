// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {IL1Block} from "../../src/interfaces/IL1Block.sol";
import {OPStackL2KeystoreVerifier} from "../../src/keystore/OPStackL2KeystoreVerifier.sol";

/// @notice Conformance evidence for the OP Stack `L1Block` predeploy.
/// @dev This is the control that was missing. `OPStackL2KeystoreVerifier` was
/// built against a `stateRoot()` function the canonical predeploy has never had.
/// Nothing caught it because the only test supplied a mock that implemented the
/// imagined function, so the suite validated the repository's assumption instead
/// of the chain's interface. A single call to the real predeploy would have failed
/// immediately.
///
/// These tests therefore assert the predeploy's surface directly: the functions
/// the verifier depends on must exist and return live values, and the function it
/// used to depend on must not exist. They run only when `OP_STACK_RPC_URL` is set;
/// the skip is explicit and reported rather than silent, and this file is not a
/// substitute for the live rehearsal required by
/// docs/operations/keystore-proof-profile.md.
contract OPStackL1BlockPredeployForkTest is Test {
    /// @notice Canonical OP Stack `L1Block` predeploy address.
    address internal constant L1_BLOCK = 0x4200000000000000000000000000000000000015;

    /// @dev Selector of the function an earlier version of this repository
    /// assumed existed: `stateRoot()`.
    bytes4 internal constant ABSENT_STATE_ROOT_SELECTOR = bytes4(keccak256("stateRoot()"));

    bool internal forkActive;

    function setUp() public {
        string memory rpcUrl = vm.envOr("OP_STACK_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);
        forkActive = true;
    }

    function testForkPredeployExposesTheAttributesTheVerifierReads() public {
        _requireFork();
        assertGt(L1_BLOCK.code.length, 0, "L1Block predeploy has no code on this chain");

        bytes32 blockHash = IL1Block(L1_BLOCK).hash();
        assertTrue(blockHash != bytes32(0), "L1Block.hash() returned zero");

        uint64 blockNumber = IL1Block(L1_BLOCK).number();
        assertGt(blockNumber, 0, "L1Block.number() returned zero");

        uint64 blockTimestamp = IL1Block(L1_BLOCK).timestamp();
        assertGt(blockTimestamp, 0, "L1Block.timestamp() returned zero");
    }

    /// @notice The predeploy publishes no state root. This is the fact the previous
    /// design got wrong, so it is asserted rather than assumed.
    function testForkPredeployDoesNotExposeAStateRoot() public {
        _requireFork();
        (bool ok,) = L1_BLOCK.staticcall(abi.encodeWithSelector(ABSENT_STATE_ROOT_SELECTOR));
        assertFalse(ok, "L1Block unexpectedly answers stateRoot(); revisit the verifier design");
    }

    /// @notice A verifier deployed against the real predeploy must construct, and
    /// its constructor probe must accept the live contract.
    function testForkVerifierDeploysAgainstTheRealPredeploy() public {
        _requireFork();
        OPStackL2KeystoreVerifier verifier = new OPStackL2KeystoreVerifier(address(0xBEEF), L1_BLOCK);
        assertEq(verifier.l1Block(), L1_BLOCK, "verifier not bound to the predeploy");
    }

    /// @notice The constructor probe must reject a chain whose `L1Block` does not
    /// answer `hash()`, so a misconfigured deployment fails loudly instead of
    /// returning false for every proof forever.
    function testForkVerifierRejectsAnAddressWithoutThePredeployInterface() public {
        _requireFork();
        // Any contract that is not the predeploy. The verifier itself will do.
        OPStackL2KeystoreVerifier probe = new OPStackL2KeystoreVerifier(address(0xBEEF), L1_BLOCK);
        vm.expectRevert(OPStackL2KeystoreVerifier.InvalidL1Block.selector);
        new OPStackL2KeystoreVerifier(address(0xBEEF), address(probe));
    }

    /// @dev Skips rather than fails when no RPC is configured, matching the
    /// repository's other fork suite. A skip here means the conformance evidence
    /// was not produced, so this suite passing locally proves nothing; the CI job
    /// that supplies `OP_STACK_RPC_URL` is where the evidence comes from.
    function _requireFork() internal {
        if (!forkActive) vm.skip(true);
    }
}
