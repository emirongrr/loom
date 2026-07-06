// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmInvariant {
    function warp(uint256 timestamp) external;
}

contract LoomAccountInvariantHandler {
    VmInvariant internal constant vm = VmInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    LoomAccount public account;
    LoomAccount public migrationDestination;
    MockTarget public target;
    MockTarget public migrationTarget;
    uint256 public migrationValue;
    bool public violated;

    function configure(
        LoomAccount account_,
        LoomAccount migrationDestination_,
        MockTarget target_,
        MockTarget migrationTarget_
    ) external {
        if (address(account) != address(0)) revert();
        account = account_;
        migrationDestination = migrationDestination_;
        target = target_;
        migrationTarget = migrationTarget_;
    }

    function executeValue(uint256 value) external {
        uint64 versionBefore = account.configVersion();
        try account.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (value))))
        ) {}
            catch {}
        _checkVersion(versionBefore);
    }

    function directGuardianConfig(bytes32 root, uint8 threshold) external {
        uint64 versionBefore = account.configVersion();
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (root, threshold)));
        if (ok) violated = true;
        _checkVersion(versionBefore);
    }

    function unsupportedExecution(uint8 callType) external {
        if (callType <= 1) return;
        uint64 versionBefore = account.configVersion();
        bytes32 mode = bytes32(uint256(callType) << 248);
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (mode, bytes(""))));
        if (ok) violated = true;
        _checkVersion(versionBefore);
    }

    function scheduleMigration(uint256 value) external {
        (,,, bytes32 pendingCallsHash,,,,) = account.pendingMigration();
        if (pendingCallsHash != bytes32(0)) return;
        uint64 versionBefore = account.configVersion();
        migrationValue = value;
        ExecutionLib.Execution[] memory calls = _migrationCalls();
        bytes memory schedule = abi.encodeCall(
            LoomAccount.scheduleMigration,
            (
                address(migrationDestination),
                address(migrationDestination).codehash,
                migrationDestination.configHash(),
                keccak256(abi.encode(calls)),
                account.MIN_CONFIG_DELAY(),
                1 days
            )
        );
        try account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule))) {} catch {}
        _checkVersion(versionBefore);
    }

    function attemptExecuteMigration() external {
        (,,, bytes32 pendingCallsHash, uint48 readyAt,,,) = account.pendingMigration();
        if (pendingCallsHash == bytes32(0)) return;
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        bool shouldBeBlocked = block.timestamp < readyAt;
        uint64 versionBefore = account.configVersion();
        uint256 valueBefore = migrationTarget.value();
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeMigration, (_migrationCalls())));
        if (shouldBeBlocked && ok) violated = true;
        if (shouldBeBlocked && migrationTarget.value() != valueBefore) violated = true;
        _checkVersion(versionBefore);
    }

    function installValidator() external {
        uint64 versionBefore = account.configVersion();
        MockValidator newValidator = new MockValidator();
        bytes memory install =
            abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(newValidator), ""));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, install, account.MIN_CONFIG_DELAY()));
        try account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule))) {
            vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
            (bool ok,) =
                address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, install)));
            if (!ok) revert();
        } catch {}
        _checkVersion(versionBefore);
        if (account.validatorCount() == 0) violated = true;
    }

    function uninstallValidator(uint256 seed) external {
        uint256 count = account.validatorCount();
        if (count == 0) {
            violated = true;
            return;
        }
        address victim = account.validatorAt(seed % count);
        uint64 versionBefore = account.configVersion();
        bytes memory uninstall = abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, victim, bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        try account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule))) {
            vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
            bool wasLastValidator = count == 1;
            (bool ok,) =
                address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));
            if (wasLastValidator && ok) violated = true;
        } catch {}
        _checkVersion(versionBefore);
        if (account.validatorCount() == 0) violated = true;
    }

    function _checkVersion(uint64 versionBefore) internal {
        if (account.configVersion() < versionBefore) violated = true;
    }

    function _migrationCalls() internal view returns (ExecutionLib.Execution[] memory calls) {
        calls = new ExecutionLib.Execution[](1);
        calls[0] =
            ExecutionLib.Execution(address(migrationTarget), 0, abi.encodeCall(MockTarget.setValue, (migrationValue)));
    }
}

contract LoomAccountInvariantTest is StdInvariant {
    LoomAccount internal account;
    LoomAccount internal migrationDestination;
    MockValidator internal validator;
    LoomAccountInvariantHandler internal handler;

    function setUp() public {
        handler = new LoomAccountInvariantHandler();
        validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(handler), keccak256("guardians"), 1, keccak256("config"), modules);
        MockValidator destinationValidator = new MockValidator();
        LoomAccount.ModuleInit[] memory destinationModules = new LoomAccount.ModuleInit[](1);
        destinationModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(destinationValidator), "");
        migrationDestination = new LoomAccount(
            address(handler), keccak256("guardians"), 1, keccak256("destination-config"), destinationModules
        );
        handler.configure(account, migrationDestination, new MockTarget(), new MockTarget());
        // Fuzz every external handler action. configure() self-guards against a
        // second call, so it needs no selector exclusion.
        targetContract(address(handler));
    }

    function invariantCoreAuthorityAndConfigRemainValid() public view {
        require(!handler.violated(), "handler observed invariant violation");
        require(account.configVersion() >= 1, "config version decreased");
        require(account.configHash() != bytes32(0), "config hash cleared");
        require(account.guardianRoot() != bytes32(0), "guardian root cleared");
        require(account.guardianThreshold() > 0, "guardian threshold cleared");
        require(account.validatorCount() >= 1, "validator count reached zero");
    }
}
