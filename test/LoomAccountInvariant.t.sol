// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {StdInvariant} from "../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

contract LoomAccountInvariantHandler {
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

    function executeMigrationBeforeDelay() external {
        (,,, bytes32 pendingCallsHash,,,,) = account.pendingMigration();
        if (pendingCallsHash == bytes32(0)) return;
        uint64 versionBefore = account.configVersion();
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeMigration, (_migrationCalls())));
        if (ok) violated = true;
        if (migrationTarget.value() != 0) violated = true;
        _checkVersion(versionBefore);
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
        targetContract(address(handler));
    }

    function invariantCoreAuthorityAndConfigRemainValid() public view {
        require(!handler.violated(), "handler observed invariant violation");
        require(account.configVersion() >= 1, "config version decreased");
        require(account.configHash() != bytes32(0), "config hash cleared");
        require(account.guardianRoot() != bytes32(0), "guardian root cleared");
        require(account.guardianThreshold() > 0, "guardian threshold cleared");
        require(account.validatorCount() == 1, "validator count changed");
        require(account.validatorAt(0) == address(validator), "validator enumeration changed");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "last validator removed");
    }

    function excludeSelectors() public pure returns (FuzzSelector[] memory selectors) {
        selectors = new FuzzSelector[](0);
    }
}
