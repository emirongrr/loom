// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmScheduled {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice Lifecycle coverage for generic scheduled calls: bounded execution
/// window, instance identity, and guardian-threshold cancellation.
/// @dev Scheduled calls used to store only `readyAt`. Once ready they stayed
/// executable forever unless an unrelated configuration change happened to
/// invalidate them, and `executeScheduled` is permissionless, so an attacker could
/// park a ready operation and publish it whenever it suited them. They were also
/// the one delayed mechanism with no guardian-threshold cancellation, so a guardian
/// who spotted a dangerous pending call could only freeze and wait for recovery.
contract ScheduledOperationLifecycleTest {
    VmScheduled internal constant vm = VmScheduled(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;

    LoomAccount internal account;
    ECDSAGuardianVerifier internal guardianVerifier;
    MockTarget internal target;
    bytes32 internal keyCommitment;
    bytes32 internal guardianSalt;
    bytes32 internal guardianLeaf;

    function setUp() public {
        guardianVerifier = new ECDSAGuardianVerifier();
        target = new MockTarget();
        address guardian = vm.addr(GUARDIAN_KEY);
        keyCommitment = keccak256(abi.encode(guardian));
        guardianSalt = keccak256("guardian-salt");
        guardianLeaf = keccak256(
            abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, guardianSalt)
        );

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        // This test contract stands in for the EntryPoint so `execute` is callable.
        account = new LoomAccount(address(this), guardianLeaf, 1, keccak256("config"), modules);
    }

    function testScheduledOperationIsExecutableExactlyInsideItsWindow() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (1));
        bytes32 operationId = _schedule(call);
        (uint48 readyAt, uint48 expiresAt,) = account.scheduledOperations(operationId);
        require(expiresAt == readyAt + account.SCHEDULE_WINDOW(), "window not bound to the schedule");

        vm.warp(readyAt - 1);
        (bool early, bytes memory earlyRevert) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, call)));
        require(!early, "executed one second before readiness");
        require(
            keccak256(earlyRevert) == keccak256(abi.encodeWithSelector(LoomAccount.OperationNotReady.selector)),
            "wrong early rejection"
        );

        vm.warp(expiresAt);
        account.executeScheduled(address(target), 0, call);
        require(target.value() == 1, "operation not executable on the last second of its window");
    }

    function testScheduledOperationExpiresAndCannotBeParkedIndefinitely() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (42));
        bytes32 operationId = _schedule(call);
        (, uint48 expiresAt,) = account.scheduledOperations(operationId);

        vm.warp(expiresAt + 1);
        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, call)));
        require(!ok, "expired operation executed");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(LoomAccount.OperationExpired.selector)),
            "wrong expiry rejection"
        );
        require(target.value() == 0, "expired operation changed state");

        // Still expired much later: expiry is terminal, not a temporary condition.
        vm.warp(expiresAt + 365 days);
        (bool late,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, call)));
        require(!late, "expired operation executed after a long wait");
    }

    function testGuardianThresholdCancelsScheduledOperationWithoutExecutionAuthority() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (7));
        bytes32 operationId = _schedule(call);
        (uint48 readyAt,, uint64 nonce) = account.scheduledOperations(operationId);
        require(nonce == 0, "first instance should start at nonce zero");

        bytes32 digest = account.cancelScheduledDigest(operationId, account.configVersion(), nonce);
        account.cancelScheduledWithGuardians(operationId, _guardianApprovals(digest));

        (uint48 afterCancel,, uint64 nonceAfter) = account.scheduledOperations(operationId);
        require(afterCancel == 0, "guardian cancellation did not clear the operation");
        require(nonceAfter == nonce + 1, "instance counter did not advance on cancellation");

        vm.warp(readyAt);
        (bool executed,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, call)));
        require(!executed, "cancelled operation executed");
        require(target.value() == 0, "cancelled operation changed state");

        // Cancellation is the whole authority. The guardian who just cancelled
        // cannot execute anything: `execute` is EntryPoint-only, and the guardian is
        // not the EntryPoint.
        vm.prank(vm.addr(GUARDIAN_KEY));
        (bool guardianExecuted, bytes memory guardianRevert) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(target), 0, call)))
                )
            );
        require(!guardianExecuted, "guardian gained execution authority");
        require(
            keccak256(guardianRevert) == keccak256(abi.encodeWithSelector(LoomAccount.OnlyEntryPoint.selector)),
            "wrong guardian execution rejection"
        );
        require(target.value() == 0, "guardian moved account state");
    }

    /// @notice A cancellation approval authorizes exactly one operation instance.
    /// @dev Cancelling publishes the approvals on chain and the entry point is
    /// permissionless, so without an instance counter those archived approvals would
    /// cancel every future re-scheduling of the same call indefinitely.
    function testGuardianCancellationCannotBeReplayedAgainstARescheduledOperation() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (9));
        bytes32 operationId = _schedule(call);
        (,, uint64 nonce) = account.scheduledOperations(operationId);

        bytes32 digest = account.cancelScheduledDigest(operationId, account.configVersion(), nonce);
        GuardianVerificationLib.Approval[] memory archived = _guardianApprovals(digest);
        account.cancelScheduledWithGuardians(operationId, archived);

        // Re-scheduling the identical call reuses the slot at the same config version.
        bytes32 rescheduledId = _schedule(call);
        require(rescheduledId == operationId, "re-scheduled operation should reuse the slot");
        (uint48 readyAt,, uint64 newNonce) = account.scheduledOperations(operationId);
        require(newNonce == nonce + 1, "re-scheduled instance reused the old counter");

        (bool replayed, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.cancelScheduledWithGuardians, (operationId, archived)));
        require(!replayed, "archived approvals cancelled a re-scheduled operation");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(LoomAccount.InvalidModule.selector)),
            "wrong replay rejection"
        );

        (uint48 stillPending,,) = account.scheduledOperations(operationId);
        require(stillPending != 0, "replay cleared the re-scheduled operation");

        // Live guardians can still cancel the new instance by signing its nonce.
        bytes32 freshDigest = account.cancelScheduledDigest(operationId, account.configVersion(), newNonce);
        account.cancelScheduledWithGuardians(operationId, _guardianApprovals(freshDigest));
        (uint48 cancelled,,) = account.scheduledOperations(operationId);
        require(cancelled == 0, "fresh approvals failed to cancel");
        require(readyAt != 0, "unused readyAt");
    }

    /// @notice Execution consumes the instance for the same reason cancellation does.
    function testApprovalForAnExecutedOperationCannotCancelALaterOne() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (3));
        bytes32 operationId = _schedule(call);
        (uint48 readyAt,, uint64 nonce) = account.scheduledOperations(operationId);
        // Signed while the operation was pending, but never submitted.
        bytes32 digest = account.cancelScheduledDigest(operationId, account.configVersion(), nonce);
        GuardianVerificationLib.Approval[] memory archived = _guardianApprovals(digest);

        vm.warp(readyAt);
        account.executeScheduled(address(target), 0, call);
        require(target.value() == 3, "operation did not execute");

        bytes32 secondId = _schedule(call);
        require(secondId == operationId, "second scheduling should reuse the slot");

        (bool replayed,) =
            address(account).call(abi.encodeCall(LoomAccount.cancelScheduledWithGuardians, (operationId, archived)));
        require(!replayed, "approval for an executed operation cancelled a later one");
        (uint48 stillPending,,) = account.scheduledOperations(operationId);
        require(stillPending != 0, "replay cleared the second operation");
    }

    /// @notice A self-cancellation also consumes the instance, so an approval signed
    /// for it cannot be used against whatever the owner schedules next.
    function testSelfCancellationAdvancesTheInstanceCounter() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (5));
        bytes32 operationId = _schedule(call);
        (,, uint64 nonce) = account.scheduledOperations(operationId);

        bytes memory cancel = abi.encodeCall(LoomAccount.cancelScheduled, (operationId));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, cancel)));

        (uint48 readyAt,, uint64 nonceAfter) = account.scheduledOperations(operationId);
        require(readyAt == 0, "self cancellation did not clear the operation");
        require(nonceAfter == nonce + 1, "self cancellation did not advance the counter");
    }

    function testGuardianCancellationRejectsUnscheduledAndWrongDigest() public {
        bytes memory call = abi.encodeCall(MockTarget.setValue, (11));
        bytes32 operationId = _schedule(call);
        (,, uint64 nonce) = account.scheduledOperations(operationId);

        bytes32 unknownId = keccak256("never scheduled");
        bytes32 unknownDigest = account.cancelScheduledDigest(unknownId, account.configVersion(), 0);
        (bool unknownOk, bytes memory unknownRevert) = address(account)
            .call(
                abi.encodeCall(LoomAccount.cancelScheduledWithGuardians, (unknownId, _guardianApprovals(unknownDigest)))
            );
        require(!unknownOk, "cancelled an operation that was never scheduled");
        require(
            keccak256(unknownRevert) == keccak256(abi.encodeWithSelector(LoomAccount.OperationNotScheduled.selector)),
            "wrong unscheduled rejection"
        );

        bytes32 wrongVersionDigest = account.cancelScheduledDigest(operationId, account.configVersion() + 1, nonce);
        (bool wrongVersion,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.cancelScheduledWithGuardians, (operationId, _guardianApprovals(wrongVersionDigest))
                )
            );
        require(!wrongVersion, "approval for a different config version accepted");

        bytes32 wrongNonceDigest = account.cancelScheduledDigest(operationId, account.configVersion(), nonce + 1);
        (bool wrongNonce,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.cancelScheduledWithGuardians, (operationId, _guardianApprovals(wrongNonceDigest))
                )
            );
        require(!wrongNonce, "approval for a different instance accepted");

        (uint48 stillPending,,) = account.scheduledOperations(operationId);
        require(stillPending != 0, "failed cancellations mutated the operation");
    }

    // --- helpers ---

    function _schedule(bytes memory call) internal returns (bytes32 operationId) {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, call, account.MIN_EXTERNAL_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        operationId = keccak256(abi.encode(address(target), uint256(0), call, account.configVersion()));
    }

    function _guardianApprovals(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, digest);
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keyCommitment,
            salt: guardianSalt,
            signature: abi.encodePacked(r, s, v),
            proof: new bytes32[](0)
        });
    }
}
