// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmMultiAccountMigrationInvariant {
    function warp(uint256 timestamp) external;
}

contract MigrationEntryPointHarness {
    function callAccount(LoomAccount account, bytes calldata data) external returns (bool ok, bytes memory result) {
        return address(account).call(data);
    }
}

contract MultiAccountMigrationHandler {
    VmMultiAccountMigrationInvariant internal constant vm =
        VmMultiAccountMigrationInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant INITIAL_BALANCE = 1_000;
    uint48 internal constant EXECUTION_WINDOW = 1 days;

    MigrationEntryPointHarness public immutable entryPoint;
    MockERC20 public immutable token;
    MockTarget public immutable aliceTarget;
    MockTarget public immutable bobTarget;
    MockTarget public immutable revertingTarget;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    LoomAccount public immutable aliceDestination;
    LoomAccount public immutable bobDestination;

    bool public violated;
    uint256 public successfulSchedules;
    uint256 public successfulExecutions;
    uint256 public successfulCancellations;
    uint256 public exactRollbackRejections;
    uint256 public exactCrossAccountRejections;

    struct Plan {
        bool active;
        bool shouldRevert;
        uint256 targetValue;
        bytes32 callsHash;
    }

    struct AccountSnapshot {
        uint256 sourceTokens;
        uint256 destinationTokens;
        uint256 targetValue;
        uint64 migrationNonce;
        bytes32 configHash;
        uint64 configVersion;
        bytes32 guardianRoot;
        uint8 guardianThreshold;
        uint256 validatorCount;
        LoomAccount.PendingMigration pending;
    }

    struct SystemSnapshot {
        AccountSnapshot aliceState;
        AccountSnapshot bobState;
    }

    mapping(address account => Plan plan) internal plans;

    constructor() {
        entryPoint = new MigrationEntryPointHarness();
        token = new MockERC20();
        aliceTarget = new MockTarget();
        bobTarget = new MockTarget();
        revertingTarget = new MockTarget();

        alice = _newAccount(keccak256("multi-account-migration-alice"));
        bob = _newAccount(keccak256("multi-account-migration-bob"));
        aliceDestination = _newAccount(keccak256("multi-account-migration-alice-destination"));
        bobDestination = _newAccount(keccak256("multi-account-migration-bob-destination"));
        token.mint(address(alice), INITIAL_BALANCE);
        token.mint(address(bob), INITIAL_BALANCE);
    }

    function scheduleAliceSuccess() external {
        _schedule(alice, bob, aliceDestination, aliceTarget, false);
    }

    function scheduleBobSuccess() external {
        _schedule(bob, alice, bobDestination, bobTarget, false);
    }

    function scheduleAliceRevertingBatch() external {
        _schedule(alice, bob, aliceDestination, aliceTarget, true);
    }

    function scheduleBobRevertingBatch() external {
        _schedule(bob, alice, bobDestination, bobTarget, true);
    }

    function executeAlice() external {
        _execute(alice, bob, aliceDestination, aliceTarget);
    }

    function executeBob() external {
        _execute(bob, alice, bobDestination, bobTarget);
    }

    function cancelAlice() external {
        _cancel(alice, bob);
    }

    function cancelBob() external {
        _cancel(bob, alice);
    }

    function rejectBobCallsForAlice() external {
        _rejectOtherCalls(alice, bob, bobDestination, bobTarget);
    }

    function rejectAliceCallsForBob() external {
        _rejectOtherCalls(bob, alice, aliceDestination, aliceTarget);
    }

    function planFor(LoomAccount account) external view returns (Plan memory) {
        return plans[address(account)];
    }

    function _schedule(
        LoomAccount account,
        LoomAccount other,
        LoomAccount destination,
        MockTarget target,
        bool shouldRevert
    ) internal {
        if (_pending(account).readyAt != 0 || (!shouldRevert && token.balanceOf(address(account)) == 0)) return;
        AccountSnapshot memory otherBefore = _snapshot(other);
        uint256 targetValue = target.value() + 1;
        ExecutionLib.Execution[] memory calls = _calls(destination, target, shouldRevert, targetValue);
        bytes memory schedule = abi.encodeCall(
            LoomAccount.scheduleMigration,
            (
                address(destination),
                address(destination).codehash,
                destination.configHash(),
                keccak256(abi.encode(calls)),
                account.MIN_CONFIG_DELAY(),
                EXECUTION_WINDOW
            )
        );
        bytes memory accountCall = abi.encodeCall(
            LoomAccount.execute,
            (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(ExecutionLib.Execution(address(account), 0, schedule)))
        );
        (bool ok,) = entryPoint.callAccount(account, accountCall);
        LoomAccount.PendingMigration memory pending = _pending(account);
        if (
            !ok || pending.destination != address(destination)
                || pending.destinationCodeHash != address(destination).codehash
                || pending.destinationConfigHash != destination.configHash()
                || pending.callsHash != keccak256(abi.encode(calls)) || pending.readyAt == 0
                || pending.expiresAt != pending.readyAt + EXECUTION_WINDOW
                || pending.configVersion != account.configVersion() || pending.nonce != account.migrationNonce()
        ) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) {
            plans[address(account)] = Plan(true, shouldRevert, targetValue, keccak256(abi.encode(calls)));
            ++successfulSchedules;
        }
    }

    function _execute(LoomAccount account, LoomAccount other, LoomAccount destination, MockTarget target) internal {
        Plan memory plan = plans[address(account)];
        LoomAccount.PendingMigration memory pending = _pending(account);
        if (!plan.active || pending.readyAt == 0) return;
        ExecutionLib.Execution[] memory calls = _calls(destination, target, plan.shouldRevert, plan.targetValue);
        SystemSnapshot memory beforeState = _systemSnapshot();
        vm.warp(pending.readyAt);

        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        if (plan.shouldRevert) {
            bytes memory expected = abi.encodeWithSignature("Error(string)", "FAIL");
            if (ok || keccak256(revertData) != keccak256(expected)) violated = true;
            if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
            if (!ok) ++exactRollbackRejections;
            return;
        }

        AccountSnapshot memory accountBefore = _select(beforeState, account);
        AccountSnapshot memory otherBefore = _select(beforeState, other);
        AccountSnapshot memory accountAfter = _snapshot(account);
        if (!ok || accountAfter.pending.readyAt != 0 || accountAfter.migrationNonce != accountBefore.migrationNonce + 1)
        {
            violated = true;
        }
        if (
            accountAfter.sourceTokens + 1 != accountBefore.sourceTokens
                || accountAfter.destinationTokens != accountBefore.destinationTokens + 1
                || accountAfter.targetValue != plan.targetValue || !_sameAuthority(accountBefore, accountAfter)
        ) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) {
            delete plans[address(account)];
            ++successfulExecutions;
        }
    }

    function _cancel(LoomAccount account, LoomAccount other) internal {
        if (_pending(account).readyAt == 0) return;
        AccountSnapshot memory accountBefore = _snapshot(account);
        AccountSnapshot memory otherBefore = _snapshot(other);
        bytes memory cancel = abi.encodeCall(LoomAccount.cancelMigration, ());
        bytes memory accountCall = abi.encodeCall(
            LoomAccount.execute,
            (ExecutionLib.SINGLE_EXECUTION_MODE, abi.encode(ExecutionLib.Execution(address(account), 0, cancel)))
        );
        (bool ok,) = entryPoint.callAccount(account, accountCall);
        AccountSnapshot memory accountAfter = _snapshot(account);
        if (!ok || accountAfter.pending.readyAt != 0 || accountAfter.migrationNonce != accountBefore.migrationNonce + 1)
        {
            violated = true;
        }
        if (!_sameAuthority(accountBefore, accountAfter)) violated = true;
        if (
            accountAfter.sourceTokens != accountBefore.sourceTokens
                || accountAfter.targetValue != accountBefore.targetValue
        ) {
            violated = true;
        }
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) {
            delete plans[address(account)];
            ++successfulCancellations;
        }
    }

    function _rejectOtherCalls(
        LoomAccount account,
        LoomAccount other,
        LoomAccount otherDestination,
        MockTarget otherTarget
    ) internal {
        Plan memory accountPlan = plans[address(account)];
        Plan memory otherPlan = plans[address(other)];
        if (!accountPlan.active || !otherPlan.active) return;
        ExecutionLib.Execution[] memory wrongCalls =
            _calls(otherDestination, otherTarget, otherPlan.shouldRevert, otherPlan.targetValue);
        if (keccak256(abi.encode(wrongCalls)) == accountPlan.callsHash) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeMigration, (wrongCalls)));
        bytes memory expected = abi.encodeWithSelector(LoomAccount.InvalidMigration.selector);
        if (ok || keccak256(revertData) != keccak256(expected)) violated = true;
        if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
        if (!ok) ++exactCrossAccountRejections;
    }

    function _calls(LoomAccount destination, MockTarget target, bool shouldRevert, uint256 targetValue)
        internal
        view
        returns (ExecutionLib.Execution[] memory calls)
    {
        calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(
            address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), uint256(1)))
        );
        calls[1] = shouldRevert
            ? ExecutionLib.Execution(address(revertingTarget), 0, abi.encodeCall(MockTarget.fail, ()))
            : ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (targetValue)));
    }

    function _newAccount(bytes32 configHash) internal returns (LoomAccount account) {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        account = new LoomAccount(
            address(entryPoint), keccak256(abi.encode(configHash, "guardians")), 1, configHash, modules
        );
    }

    function _snapshot(LoomAccount account) internal view returns (AccountSnapshot memory state) {
        (LoomAccount destination, MockTarget target) =
            address(account) == address(alice) ? (aliceDestination, aliceTarget) : (bobDestination, bobTarget);
        state = AccountSnapshot({
            sourceTokens: token.balanceOf(address(account)),
            destinationTokens: token.balanceOf(address(destination)),
            targetValue: target.value(),
            migrationNonce: account.migrationNonce(),
            configHash: account.configHash(),
            configVersion: account.configVersion(),
            guardianRoot: account.guardianRoot(),
            guardianThreshold: account.guardianThreshold(),
            validatorCount: account.validatorCount(),
            pending: _pending(account)
        });
    }

    function _pending(LoomAccount account) internal view returns (LoomAccount.PendingMigration memory pending) {
        (
            pending.destination,
            pending.destinationCodeHash,
            pending.destinationConfigHash,
            pending.callsHash,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = account.pendingMigration();
    }

    function _systemSnapshot() internal view returns (SystemSnapshot memory state) {
        state = SystemSnapshot({aliceState: _snapshot(alice), bobState: _snapshot(bob)});
    }

    function _select(SystemSnapshot memory state, LoomAccount account) internal view returns (AccountSnapshot memory) {
        return address(account) == address(alice) ? state.aliceState : state.bobState;
    }

    function _sameAuthority(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return left.configHash == right.configHash && left.configVersion == right.configVersion
            && left.guardianRoot == right.guardianRoot && left.guardianThreshold == right.guardianThreshold
            && left.validatorCount == right.validatorCount;
    }

    function _sameAccountState(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _sameSystemState(SystemSnapshot memory left, SystemSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }
}

contract MultiAccountMigrationInvariantTest is StdInvariant {
    MultiAccountMigrationHandler internal handler;

    function setUp() public {
        handler = new MultiAccountMigrationHandler();
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = MultiAccountMigrationHandler.scheduleAliceSuccess.selector;
        selectors[1] = MultiAccountMigrationHandler.scheduleBobSuccess.selector;
        selectors[2] = MultiAccountMigrationHandler.scheduleAliceRevertingBatch.selector;
        selectors[3] = MultiAccountMigrationHandler.scheduleBobRevertingBatch.selector;
        selectors[4] = MultiAccountMigrationHandler.executeAlice.selector;
        selectors[5] = MultiAccountMigrationHandler.executeBob.selector;
        selectors[6] = MultiAccountMigrationHandler.cancelAlice.selector;
        selectors[7] = MultiAccountMigrationHandler.cancelBob.selector;
        selectors[8] = MultiAccountMigrationHandler.rejectBobCallsForAlice.selector;
        selectors[9] = MultiAccountMigrationHandler.rejectAliceCallsForBob.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function testMigrationActionCoverage() public {
        handler.scheduleAliceSuccess();
        handler.executeAlice();

        handler.scheduleAliceRevertingBatch();
        handler.executeAlice();
        handler.cancelAlice();

        handler.scheduleAliceSuccess();
        handler.scheduleBobSuccess();
        handler.rejectBobCallsForAlice();

        require(handler.successfulSchedules() >= 4, "migration schedule action did not reach success");
        require(handler.successfulExecutions() >= 1, "migration execution action did not reach success");
        require(handler.successfulCancellations() >= 1, "migration cancellation action did not reach success");
        require(handler.exactRollbackRejections() >= 1, "migration rollback rejection was not exercised");
        require(handler.exactCrossAccountRejections() >= 1, "cross-account migration rejection was not exercised");
        require(!handler.violated(), "migration action coverage observed an invariant violation");
    }

    function invariantMigrationAuthorityAndBindingsRemainAccountScoped() public view {
        require(!handler.violated(), "multi-account migration handler observed an invariant violation");
        _assertPendingBound(handler.alice(), handler.aliceDestination());
        _assertPendingBound(handler.bob(), handler.bobDestination());
        require(address(handler.alice()) != address(handler.bob()), "migration source identities collided");
        require(
            address(handler.aliceDestination()) != address(handler.bobDestination()),
            "migration destination identities collided"
        );
    }

    function invariantMigrationTokenBalancesRemainConserved() public view {
        uint256 accounted = handler.token().balanceOf(address(handler.alice()))
            + handler.token().balanceOf(address(handler.bob()))
            + handler.token().balanceOf(address(handler.aliceDestination()))
            + handler.token().balanceOf(address(handler.bobDestination()));
        require(accounted == 2_000, "migration token accounting diverged");
    }

    function _assertPendingBound(LoomAccount account, LoomAccount destination) internal view {
        LoomAccount.PendingMigration memory pending = _pending(account);
        MultiAccountMigrationHandler.Plan memory plan = handler.planFor(account);
        require((pending.readyAt != 0) == plan.active, "migration model and pending state diverged");
        if (!plan.active) return;
        require(pending.destination == address(destination), "pending migration destination drifted");
        require(pending.destinationCodeHash == address(destination).codehash, "pending destination codehash drifted");
        require(pending.destinationConfigHash == destination.configHash(), "pending destination config drifted");
        require(pending.callsHash == plan.callsHash, "pending migration calls drifted");
        require(pending.configVersion == account.configVersion(), "pending migration version drifted");
        require(pending.nonce == account.migrationNonce(), "pending migration nonce drifted");
    }

    function _pending(LoomAccount account) internal view returns (LoomAccount.PendingMigration memory pending) {
        (
            pending.destination,
            pending.destinationCodeHash,
            pending.destinationConfigHash,
            pending.callsHash,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = account.pendingMigration();
    }
}
