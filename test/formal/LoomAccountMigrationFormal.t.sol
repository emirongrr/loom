// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {MigrationModule} from "../../src/MigrationModule.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountMigrationFormal is FormalAccountBase {
    struct AccountSnapshot {
        bytes32 configHash;
        bytes32 guardianRoot;
        address validator;
        uint64 configVersion;
        uint48 frozenUntil;
        uint8 guardianThreshold;
        uint256 validatorNonce;
    }

    function _accountSnapshot(LoomAccount account) internal view returns (AccountSnapshot memory snapshot) {
        snapshot.configHash = account.configHash();
        snapshot.guardianRoot = account.guardianRoot();
        snapshot.validator = account.validatorAt(0);
        snapshot.configVersion = account.configVersion();
        snapshot.frozenUntil = account.frozenUntil();
        snapshot.guardianThreshold = account.guardianThreshold();
        snapshot.validatorNonce = account.directExecutionNonces(snapshot.validator);
    }

    function _assertAccountUnchanged(LoomAccount account, AccountSnapshot memory expected) internal view {
        assert(account.configHash() == expected.configHash);
        assert(account.guardianRoot() == expected.guardianRoot);
        assert(account.validatorCount() == 1);
        assert(account.validatorAt(0) == expected.validator);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, expected.validator));
        assert(account.configVersion() == expected.configVersion);
        assert(account.frozenUntil() == expected.frozenUntil);
        assert(account.guardianThreshold() == expected.guardianThreshold);
        assert(account.directExecutionNonces(expected.validator) == expected.validatorNonce);
        assert(!account.isExecutingScheduled());
    }

    function _pendingMigration(LoomAccount account)
        internal
        view
        returns (MigrationModule.PendingMigration memory pending)
    {
        (
            pending.destination,
            pending.destinationCodeHash,
            pending.destinationConfigHash,
            pending.callsHash,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = MigrationModule(account.migrationModule()).pendingMigrations(address(account));
    }

    function _assertPendingMigrationUnchanged(LoomAccount account, MigrationModule.PendingMigration memory expected)
        internal
        view
    {
        MigrationModule.PendingMigration memory actual = _pendingMigration(account);
        assert(actual.destination == expected.destination);
        assert(actual.destinationCodeHash == expected.destinationCodeHash);
        assert(actual.destinationConfigHash == expected.destinationConfigHash);
        assert(actual.callsHash == expected.callsHash);
        assert(actual.readyAt == expected.readyAt);
        assert(actual.expiresAt == expected.expiresAt);
        assert(actual.configVersion == expected.configVersion);
        assert(actual.nonce == expected.nonce);
    }

    function _assertRevert(bytes memory revertData, bytes memory expectedRevertData) internal pure {
        assert(keccak256(revertData) == keccak256(expectedRevertData));
    }

    function testFuzz_MigrationDelayIsEnforced(uint256 newValue) public {
        check_MigrationDelayIsEnforced(newValue);
    }

    function check_MigrationDelayIsEnforced(uint256 newValue) public {
        (LoomAccount source,) = _migrationAccount();
        (LoomAccount destination,) = _migrationAccount();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory calls = _singleCall(target, newValue);
        _scheduleMigration(source, destination, calls);
        MigrationModule.PendingMigration memory pendingBefore = _pendingMigration(source);
        AccountSnapshot memory accountBefore = _accountSnapshot(source);
        MigrationModule module = MigrationModule(source.migrationModule());
        uint64 migrationNonceBefore = module.migrationNonces(address(source));

        (bool ok, bytes memory revertData) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        assert(!ok);
        _assertRevert(revertData, abi.encodeWithSelector(MigrationModule.OperationNotReady.selector));
        _assertPendingMigrationUnchanged(source, pendingBefore);
        assert(module.migrationNonces(address(source)) == migrationNonceBefore);
        _assertAccountUnchanged(source, accountBefore);
        assert(target.value() == 0);
    }

    function testFuzz_MigrationHashBinding(uint256 scheduledValue, uint256 wrongValue) public {
        check_MigrationHashBinding(scheduledValue, wrongValue);
    }

    function check_MigrationHashBinding(uint256 scheduledValue, uint256 wrongValue) public {
        if (scheduledValue == wrongValue) return;
        (LoomAccount source,) = _migrationAccount();
        (LoomAccount destination,) = _migrationAccount();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory scheduledCalls = _singleCall(target, scheduledValue);
        ExecutionLib.Execution[] memory wrongCalls = _singleCall(target, wrongValue);
        _scheduleMigration(source, destination, scheduledCalls);
        MigrationModule.PendingMigration memory pendingBefore = _pendingMigration(source);
        AccountSnapshot memory accountBefore = _accountSnapshot(source);
        MigrationModule module = MigrationModule(source.migrationModule());
        uint64 migrationNonceBefore = module.migrationNonces(address(source));
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());

        (bool ok, bytes memory revertData) =
            address(source).call(abi.encodeCall(LoomAccount.executeMigration, (wrongCalls)));

        assert(!ok);
        _assertRevert(revertData, abi.encodeWithSelector(MigrationModule.InvalidMigration.selector));
        _assertPendingMigrationUnchanged(source, pendingBefore);
        assert(module.migrationNonces(address(source)) == migrationNonceBefore);
        _assertAccountUnchanged(source, accountBefore);
        assert(target.value() == 0);
    }

    function testFuzz_MigrationBatchAtomicity(uint256 newValue) public {
        check_MigrationBatchAtomicity(newValue);
    }

    function check_MigrationBatchAtomicity(uint256 newValue) public {
        (LoomAccount source,) = _migrationAccount();
        (LoomAccount destination,) = _migrationAccount();
        FormalTarget target = new FormalTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (newValue)));
        calls[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.fail, ()));
        _scheduleMigration(source, destination, calls);
        MigrationModule.PendingMigration memory pendingBefore = _pendingMigration(source);
        AccountSnapshot memory accountBefore = _accountSnapshot(source);
        MigrationModule module = MigrationModule(source.migrationModule());
        uint64 migrationNonceBefore = module.migrationNonces(address(source));
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());

        (bool ok, bytes memory revertData) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        assert(!ok);
        _assertRevert(revertData, abi.encodeWithSignature("Error(string)", "FAIL"));
        _assertPendingMigrationUnchanged(source, pendingBefore);
        assert(module.migrationNonces(address(source)) == migrationNonceBefore);
        _assertAccountUnchanged(source, accountBefore);
        assert(target.value() == 0);
    }

    function _scheduleMigration(LoomAccount source, LoomAccount destination, ExecutionLib.Execution[] memory calls)
        internal
    {
        _executeFromEntryPoint(
            source,
            ExecutionLib.Execution(
                source.migrationModule(),
                0,
                abi.encodeCall(
                    MigrationModule.scheduleMigration,
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

    function _migrationAccount() internal returns (LoomAccount account, MockValidator validator) {
        validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(new MigrationModule()), "");
        account = new LoomAccount(_entryPointAddress(), keccak256("guardians"), 1, keccak256("config"), modules);
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
