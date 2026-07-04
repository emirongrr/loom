// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {FormalAccountBase, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountMigrationFormal is FormalAccountBase {
    function testFuzz_MigrationDelayIsEnforced(uint256 newValue) public {
        check_MigrationDelayIsEnforced(newValue);
    }

    function check_MigrationDelayIsEnforced(uint256 newValue) public {
        (LoomAccount source,) = _account();
        (LoomAccount destination,) = _account();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory calls = _singleCall(target, newValue);
        _scheduleMigration(source, destination, calls);

        (bool ok,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        assert(!ok);
        assert(callsHash != bytes32(0));
        assert(source.migrationNonce() == 0);
        assert(target.value() == 0);
    }

    function testFuzz_MigrationHashBinding(uint256 scheduledValue, uint256 wrongValue) public {
        check_MigrationHashBinding(scheduledValue, wrongValue);
    }

    function check_MigrationHashBinding(uint256 scheduledValue, uint256 wrongValue) public {
        if (scheduledValue == wrongValue) return;
        (LoomAccount source,) = _account();
        (LoomAccount destination,) = _account();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory scheduledCalls = _singleCall(target, scheduledValue);
        ExecutionLib.Execution[] memory wrongCalls = _singleCall(target, wrongValue);
        _scheduleMigration(source, destination, scheduledCalls);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());

        (bool ok,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (wrongCalls)));

        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        assert(!ok);
        assert(callsHash == keccak256(abi.encode(scheduledCalls)));
        assert(source.migrationNonce() == 0);
        assert(target.value() == 0);
    }

    function testFuzz_MigrationBatchAtomicity(uint256 newValue) public {
        check_MigrationBatchAtomicity(newValue);
    }

    function check_MigrationBatchAtomicity(uint256 newValue) public {
        (LoomAccount source,) = _account();
        (LoomAccount destination,) = _account();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));
        calls[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.fail, ()));
        _scheduleMigration(source, destination, calls);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());

        (bool ok,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        assert(!ok);
        assert(callsHash == keccak256(abi.encode(calls)));
        assert(source.migrationNonce() == 0);
        assert(target.value() == 0);
    }

    function _scheduleMigration(LoomAccount source, LoomAccount destination, ExecutionLib.Execution[] memory calls)
        internal
    {
        _executeFromEntryPoint(
            source,
            ExecutionLib.Execution(
                address(source),
                0,
                abi.encodeCall(
                    LoomAccount.scheduleMigration,
                    (
                        address(destination),
                        address(destination).codehash,
                        destination.configHash(),
                        keccak256(abi.encode(calls)),
                        source.MIN_CONFIG_DELAY(),
                        1 days
                    )
                )
            )
        );
    }

    function _singleCall(FormalTarget target, uint256 newValue)
        internal
        pure
        returns (ExecutionLib.Execution[] memory calls)
    {
        calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));
    }
}
