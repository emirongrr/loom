// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/LoomAccount.sol";

interface VmSdkCalldata {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
}

/// @notice Solidity side of the SDK calldata differential. The @loom/account
/// lifecycle encoder hand-rolls ABI encoding — hardcoded 4-byte selectors and
/// manual offset/tuple math — so it can silently drift from the LoomAccount
/// signatures it targets. Each case in test/fixtures/sdk-calldata.json holds the
/// calldata the encoder produced; here we recompute the same call with Solidity
/// abi.encodeCall and assert byte-equality. If a LoomAccount signature changes,
/// abi.encodeCall changes and this test fails until the encoder (and fixture)
/// are updated, so encoder and contract can never disagree unnoticed.
contract SdkCalldataDifferentialTest {
    VmSdkCalldata internal constant vm = VmSdkCalldata(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/sdk-calldata.json");
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }

    function _uint(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function _bytes(string memory key) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, key);
    }

    function _assertMatches(string memory name, bytes memory actual) internal view {
        bytes memory expected = _bytes(string.concat(".cases.", name, ".calldata"));
        require(keccak256(actual) == keccak256(expected), string.concat(name, ": SDK calldata != abi.encodeCall"));
    }

    function _args(string memory name, string memory field) internal pure returns (string memory) {
        return string.concat(".cases.", name, ".args.", field);
    }

    function testScheduleCallMatches() public view {
        string memory n = "scheduleCall";
        _assertMatches(
            n,
            abi.encodeCall(
                LoomAccount.scheduleCall,
                (
                    _addr(_args(n, "target")),
                    _uint(_args(n, "value")),
                    _bytes(_args(n, "data")),
                    uint48(_uint(_args(n, "delay")))
                )
            )
        );
    }

    function testExecuteScheduledMatches() public view {
        string memory n = "executeScheduled";
        _assertMatches(
            n,
            abi.encodeCall(
                LoomAccount.executeScheduled,
                (_addr(_args(n, "target")), _uint(_args(n, "value")), _bytes(_args(n, "data")))
            )
        );
    }

    function testExecuteScheduledEmptyDataMatches() public view {
        string memory n = "executeScheduledEmptyData";
        _assertMatches(
            n,
            abi.encodeCall(
                LoomAccount.executeScheduled,
                (_addr(_args(n, "target")), _uint(_args(n, "value")), _bytes(_args(n, "data")))
            )
        );
    }

    function testCancelScheduledMatches() public view {
        string memory n = "cancelScheduled";
        _assertMatches(n, abi.encodeCall(LoomAccount.cancelScheduled, (_b32(_args(n, "operationId")))));
    }

    function testScheduleMigrationMatches() public view {
        string memory n = "scheduleMigration";
        _assertMatches(
            n,
            abi.encodeCall(
                LoomAccount.scheduleMigration,
                (
                    _addr(_args(n, "destination")),
                    _b32(_args(n, "destinationCodeHash")),
                    _b32(_args(n, "destinationConfigHash")),
                    _b32(_args(n, "callsHash")),
                    uint48(_uint(_args(n, "delay"))),
                    uint48(_uint(_args(n, "executionWindow")))
                )
            )
        );
    }

    function testCancelMigrationMatches() public view {
        _assertMatches("cancelMigration", abi.encodeCall(LoomAccount.cancelMigration, ()));
    }

    function testRevokeTokenAllowanceMatches() public view {
        string memory n = "revokeTokenAllowance";
        _assertMatches(
            n, abi.encodeCall(LoomAccount.revokeTokenAllowance, (_addr(_args(n, "token")), _addr(_args(n, "spender"))))
        );
    }
}
