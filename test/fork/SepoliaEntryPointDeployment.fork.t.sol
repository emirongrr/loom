// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @notice Live conformance evidence for the ERC-4337 v0.9 contracts pinned by
/// the Sepolia deployment script.
/// @dev The test is skipped unless `SEPOLIA_RPC_URL` is supplied. A skipped run
/// proves only that the harness compiles; release evidence requires a passing
/// run against the deployment RPC used for the release.
contract SepoliaEntryPointDeploymentForkTest is Test {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    address internal constant ENTRY_POINT = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;
    bytes32 internal constant ENTRY_POINT_RUNTIME_CODEHASH =
        0x280d5c7c0de94b512401eb9c4b0ef0436275ff03627aad0ce1f93ab1627187a0;
    address internal constant SENDER_CREATOR = 0x0A630a99Df908A81115A3022927Be82f9299987e;
    bytes32 internal constant SENDER_CREATOR_RUNTIME_CODEHASH =
        0xa7d4dd260bca9c96da49f7c0682fdda7f0074694d935815a336d3e60ee3ec6ad;

    bool internal forkActive;

    function setUp() public {
        string memory rpcUrl = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);
        forkActive = true;
        assertEq(block.chainid, SEPOLIA_CHAIN_ID, "fork is not Sepolia");
    }

    function testForkOfficialEntryPointAndSenderCreatorMatchPinnedRelease() public {
        _requireFork();
        assertEq(ENTRY_POINT.codehash, ENTRY_POINT_RUNTIME_CODEHASH, "EntryPoint runtime code changed");
        assertEq(address(IEntryPoint(ENTRY_POINT).senderCreator()), SENDER_CREATOR, "SenderCreator address changed");
        assertEq(SENDER_CREATOR.codehash, SENDER_CREATOR_RUNTIME_CODEHASH, "SenderCreator runtime code changed");
    }

    function _requireFork() internal {
        if (!forkActive) vm.skip(true);
    }
}
