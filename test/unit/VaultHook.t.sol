// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {VaultHook} from "../../src/hooks/VaultHook.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPayableERC20} from "../mocks/MockPayableERC20.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmVault {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract VaultHookTest {
    VmVault internal constant vm = VmVault(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant SECOND_GUARDIAN_KEY = 0xB0B;

    ECDSAGuardianVerifier internal guardianVerifier = new ECDSAGuardianVerifier();

    function testDailySpendingLimitSeparatesDailyAccountFromVault() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        _executeTransfer(account, token, address(0xBEEF), 7);
        require(token.balanceOf(address(0xBEEF)) == 7, "daily transfer failed");

        (bool overDaily,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 4))
                            )
                        )
                    )
                )
            );
        require(!overDaily, "daily limit was bypassed");

        vm.warp(block.timestamp + 1 days);
        _executeTransfer(account, token, address(0xBEEF), 10);
        require(token.balanceOf(address(0xBEEF)) == 17, "daily period did not reset");
    }

    function testDelayedVaultWithdrawalIsExactAndAtomic() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);

        (bool early,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, transfer)));
        require(!early, "vault withdrawal executed before account schedule");

        _schedule(account, address(token), transfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());
        (bool beforeVaultDelay,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, transfer)));
        require(!beforeVaultDelay, "vault withdrawal executed before vault delay");

        vm.warp(block.timestamp + 1 days);
        account.executeScheduled(address(token), 0, transfer);
        require(token.balanceOf(address(0xCAFE)) == 50, "vault withdrawal failed");
        (uint48 readyAt,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(readyAt == 0, "vault withdrawal not consumed");
    }

    function testGuardianThresholdCancelsVaultWithdrawalWithoutSpendingAuthority() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(account), withdrawalId);
        bytes32 digest = vault.cancelWithdrawalDigest(address(account), withdrawalId, version, nonce);

        vault.cancelVaultWithdrawalWithGuardians(address(account), withdrawalId, _guardianApprovals(digest));

        (uint48 readyAt,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(readyAt == 0, "guardian cancellation failed");
        _schedule(account, address(token), transfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 3 days);
        (bool executed,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, transfer)));
        require(!executed, "guardian-cancelled withdrawal executed");
        require(token.balanceOf(address(0xCAFE)) == 0, "guardian cancellation moved assets");
    }

    function testGuardianVaultCancellationRejectsDuplicateMissingAndWrongDigest() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(account), withdrawalId);
        bytes32 digest = vault.cancelWithdrawalDigest(address(account), withdrawalId, version, nonce);
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(digest);

        GuardianVerificationLib.Approval[] memory missing = new GuardianVerificationLib.Approval[](1);
        missing[0] = approvals[0];
        (bool acceptedMissing,) = address(vault)
            .call(
                abi.encodeCall(VaultHook.cancelVaultWithdrawalWithGuardians, (address(account), withdrawalId, missing))
            );
        require(!acceptedMissing, "missing guardian threshold accepted");

        GuardianVerificationLib.Approval[] memory duplicate = new GuardianVerificationLib.Approval[](2);
        duplicate[0] = approvals[0];
        duplicate[1] = approvals[0];
        (bool acceptedDuplicate,) = address(vault)
            .call(
                abi.encodeCall(
                    VaultHook.cancelVaultWithdrawalWithGuardians, (address(account), withdrawalId, duplicate)
                )
            );
        require(!acceptedDuplicate, "duplicate guardian accepted");

        bytes32 wrongDigest = vault.cancelWithdrawalDigest(address(account), withdrawalId, version + 1, nonce);
        (bool acceptedWrongDigest,) = address(vault)
            .call(
                abi.encodeCall(
                    VaultHook.cancelVaultWithdrawalWithGuardians,
                    (address(account), withdrawalId, _guardianApprovals(wrongDigest))
                )
            );
        require(!acceptedWrongDigest, "wrong digest accepted");

        (uint48 readyAt,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(readyAt != 0, "failed cancellation mutated pending withdrawal");
    }

    function testEthVaultWithdrawalUsesSameDelayModel() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        payable(address(account)).transfer(2 ether);
        _setPolicy(account, vault, address(0), 0.1 ether, 1 days, 2 days);

        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(0xBEEF), 1 ether, "");
        _scheduleValue(account, address(0xBEEF), 1 ether, "", account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 3 days);
        account.executeScheduled(address(0xBEEF), 1 ether, "");

        require(address(0xBEEF).balance == 1 ether, "eth vault withdrawal failed");
        (uint48 readyAt,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(readyAt == 0, "eth withdrawal not consumed");
    }

    function testRevertingVaultWithdrawalPreservesPendingState() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockTarget target = new MockTarget();
        payable(address(account)).transfer(1 ether);
        _setPolicy(account, vault, address(0), 0.1 ether, 1 days, 2 days);

        bytes memory failing = abi.encodeCall(MockTarget.fail, ());
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(target), 1 ether, failing);
        _scheduleValue(account, address(target), 1 ether, failing, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 3 days);

        (bool executed,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 1 ether, failing)));

        require(!executed, "reverting vault withdrawal succeeded");
        (uint48 readyAt,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(readyAt != 0, "reverting withdrawal consumed pending state");
    }

    function testPolicyLifecycleRejectsInvalidAndRemovalStopsProtection() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);

        VaultHook.VaultPolicy memory invalid = VaultHook.VaultPolicy(10, 0, 2 days, true);
        (bool rejectedInvalid,) =
            address(vault).call(abi.encodeCall(VaultHook.setVaultPolicy, (address(token), invalid)));
        require(!rejectedInvalid, "invalid policy accepted");

        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);
        bytes memory remove = abi.encodeCall(VaultHook.removeVaultPolicy, (address(token)));
        _schedule(account, address(vault), remove, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vault), 0, remove);

        _executeTransfer(account, token, address(0xBEEF), 50);
        require(token.balanceOf(address(0xBEEF)) == 50, "removed policy still protected asset");
    }

    function testSetAndRemoveVaultPolicyRejectUnscheduledCalls() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();

        VaultHook.VaultPolicy memory policy = VaultHook.VaultPolicy(10, 1 days, 2 days, true);
        (bool acceptedSet,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(vault), 0, abi.encodeCall(VaultHook.setVaultPolicy, (address(token), policy))
                            )
                        )
                    )
                )
            );
        require(!acceptedSet, "unscheduled setVaultPolicy accepted");

        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);
        (bool acceptedRemove,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(vault), 0, abi.encodeCall(VaultHook.removeVaultPolicy, (address(token)))
                            )
                        )
                    )
                )
            );
        require(!acceptedRemove, "unscheduled removeVaultPolicy accepted");
    }

    function testSetVaultPolicyRejectsDelayBelowMinimum() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();

        VaultHook.VaultPolicy memory tooShort = VaultHook.VaultPolicy(10, 1 days, vault.MIN_VAULT_DELAY() - 1, true);
        bytes memory data = abi.encodeCall(VaultHook.setVaultPolicy, (address(token), tooShort));
        _schedule(account, address(vault), data, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool accepted,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(vault), 0, data)));
        require(!accepted, "vault policy delay below minimum accepted");

        _setPolicy(account, vault, address(token), 10, 1 days, vault.MIN_VAULT_DELAY());
    }

    function testScheduleVaultWithdrawalRejectsExecutionWindowBeyondMaximum() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes memory overLong = abi.encodeCall(
            VaultHook.scheduleVaultWithdrawal, (address(token), 0, transfer, vault.MAX_WITHDRAWAL_WINDOW() + 1)
        );
        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(vault), 0, overLong)))
                )
            );
        require(!ok, "execution window beyond maximum accepted");

        _scheduleVaultWithdrawalWindow(account, vault, address(token), 0, transfer, vault.MAX_WITHDRAWAL_WINDOW());
    }

    function testVaultWithdrawalRejectsDuplicateExpiryAndStaleConfig() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory unprotected = abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(0xBEEF), 0, "", 7 days));
        _schedule(account, address(vault), unprotected, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool rejectedUnprotected,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(vault), 0, unprotected)));
        require(!rejectedUnprotected, "unprotected vault withdrawal accepted");

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        bytes memory duplicate =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(token), 0, transfer, 7 days));
        _schedule(account, address(vault), duplicate, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool rejectedDuplicate,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(vault), 0, duplicate)));
        require(!rejectedDuplicate, "duplicate withdrawal accepted");

        bytes memory expiredTransfer = abi.encodeCall(MockERC20.transfer, (address(0xD00D), 40));
        _scheduleVaultWithdrawalWindow(account, vault, address(token), 0, expiredTransfer, 1 days);
        _schedule(account, address(token), expiredTransfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY() + 2 days + 1);
        (bool rejectedExpired,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, expiredTransfer)));
        require(!rejectedExpired, "expired withdrawal executed");

        bytes memory staleTransfer = abi.encodeCall(MockERC20.transfer, (address(0xF00D), 30));
        _scheduleVaultWithdrawal(account, vault, address(token), 0, staleTransfer);
        _setPolicy(account, vault, address(token), 11, 1 days, 2 days);
        _schedule(account, address(token), staleTransfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());
        (bool rejectedStale,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, staleTransfer)));
        require(!rejectedStale, "stale-config withdrawal executed");
    }

    function testBatchApproveAndMalformedERC20CalldataAreProtected() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 15, 1 days, 2 days);

        ExecutionLib.Execution[] memory batch = new ExecutionLib.Execution[](2);
        batch[0] = ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 7)));
        batch[1] = ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (address(0xCAFE), 7)));
        account.execute(bytes32(uint256(1) << 248), abi.encode(batch));
        require(token.balanceOf(address(0xBEEF)) == 7, "batch transfer failed");
        require(token.allowance(address(account), address(0xCAFE)) == 7, "batch approve failed");

        (bool overBatch,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 2))
                            )
                        )
                    )
                )
            );
        require(!overBatch, "batch accounting was not enforced");

        bytes memory malformed = abi.encodePacked(bytes4(0xa9059cbb), bytes1(0x01));
        (bool rejectedMalformed,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, malformed)))
                )
            );
        require(!rejectedMalformed, "malformed protected calldata accepted");
    }

    function testTransferFromPolicyOnlyProtectsAccountSource() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 200, 1 days, 2 days);

        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (address(account), 100)))
            )
        );
        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(token), 0, abi.encodeCall(MockERC20.transferFrom, (address(account), address(0xBEEF), 25))
                )
            )
        );
        require(token.balanceOf(address(0xBEEF)) == 25, "transferFrom from account failed");

        bytes memory notAccountSource = abi.encodeCall(MockERC20.transferFrom, (address(0xCAFE), address(0xBEEF), 25));
        (bool rejectedByToken,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, notAccountSource)))
                )
            );
        require(!rejectedByToken, "mock token unexpectedly allowed transferFrom");
    }

    function testEthAttachedTokenCallCannotReclassifyProtectedTokenSpend() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(1);
        MockPayableERC20 token = new MockPayableERC20();
        token.mint(address(account), 100);
        payable(address(account)).transfer(1 ether);
        // Token policy only; deliberately no ETH policy, so a reclassified
        // spend would be entirely unmetered.
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        // Attaching 1 wei to a transfer on a payable token must not dodge the
        // token policy: even an amount under the daily limit is metered as
        // unbounded and requires the scheduled withdrawal path.
        bytes memory smallTransfer = abi.encodeCall(MockPayableERC20.transfer, (address(0xBEEF), 5));
        (bool smallMixed,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 1, smallTransfer)))
                )
            );
        require(!smallMixed, "ETH-attached token call bypassed token policy");

        bytes memory largeTransfer = abi.encodeCall(MockPayableERC20.transfer, (address(0xBEEF), 50));
        (bool largeMixed,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 1, largeTransfer)))
                )
            );
        require(!largeMixed, "ETH-attached over-limit token call bypassed token policy");
        require(token.balanceOf(address(0xBEEF)) == 0, "protected token moved without withdrawal");

        // The mixed spend is delayed and visible, not permanently blocked: the
        // scheduled withdrawal path still executes it exactly.
        bytes memory withdrawal =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(token), 1, largeTransfer, uint48(7 days)));
        _schedule(account, address(vault), withdrawal, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vault), 0, withdrawal);

        _scheduleValue(account, address(token), 1, largeTransfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 2 days);
        account.executeScheduled(address(token), 1, largeTransfer);
        require(token.balanceOf(address(0xBEEF)) == 50, "scheduled mixed withdrawal failed");

        // A plain token transfer under the daily limit still flows freely.
        bytes memory plainTransfer = abi.encodeCall(MockPayableERC20.transfer, (address(0xBEEF), 5));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, plainTransfer)));
        require(token.balanceOf(address(0xBEEF)) == 55, "plain token transfer under limit blocked");
    }

    /// @notice A guardian cancellation authorizes exactly one withdrawal instance.
    /// @dev `withdrawalId` identifies a call shape at a configuration version, so
    /// re-scheduling the same withdrawal reuses the slot. Cancelling publishes the
    /// guardian approvals on chain. Without an instance counter those archived
    /// approvals stayed valid for every later occupant of the slot, so anyone --
    /// the cancellation entry point is permissionless, gated only by signature
    /// validity -- could replay them to kill each re-scheduled withdrawal forever,
    /// with no live guardian involved. The owner's only escape was perturbing the
    /// call or forcing a `configVersion` bump through the 3-day config path.
    function testGuardianCancellationCannotBeReplayedAgainstARescheduledWithdrawal() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(nonce == 0, "first instance should start at nonce zero");

        bytes32 digest = vault.cancelWithdrawalDigest(address(account), withdrawalId, version, nonce);
        GuardianVerificationLib.Approval[] memory archived = _guardianApprovals(digest);
        vault.cancelVaultWithdrawalWithGuardians(address(account), withdrawalId, archived);

        // Re-scheduling the identical withdrawal reuses the same slot, and the
        // configuration version has not moved, so the identity is unchanged.
        bytes32 rescheduledId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        require(rescheduledId == withdrawalId, "re-scheduled withdrawal should reuse the slot");
        (,, uint64 newVersion, uint64 newNonce) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(newVersion == version, "config version moved; replay would be masked");
        require(newNonce == nonce + 1, "instance counter did not advance on cancellation");

        // The archived approvals must not authorize the new instance.
        (bool replayed, bytes memory revertData) = address(vault)
            .call(
                abi.encodeCall(VaultHook.cancelVaultWithdrawalWithGuardians, (address(account), withdrawalId, archived))
            );
        require(!replayed, "archived guardian approvals cancelled a re-scheduled withdrawal");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(VaultHook.InvalidWithdrawal.selector)),
            "wrong replay rejection"
        );

        (uint48 stillPending,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(stillPending != 0, "replay cleared the pending withdrawal");

        // Live guardians can still cancel the new instance by signing its nonce,
        // so the counter narrows the authorization rather than removing it.
        bytes32 freshDigest = vault.cancelWithdrawalDigest(address(account), withdrawalId, newVersion, newNonce);
        vault.cancelVaultWithdrawalWithGuardians(address(account), withdrawalId, _guardianApprovals(freshDigest));
        (uint48 cancelled,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(cancelled == 0, "fresh guardian approvals failed to cancel");
        require(token.balanceOf(address(0xCAFE)) == 0, "cancellation moved assets");
    }

    /// @notice Successful execution consumes the instance for the same reason.
    function testExecutedWithdrawalApprovalCannotCancelAnIdenticalLaterOne() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 200);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 withdrawalId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(account), withdrawalId);
        // Signed while the withdrawal was pending but never submitted.
        bytes32 digest = vault.cancelWithdrawalDigest(address(account), withdrawalId, version, nonce);
        GuardianVerificationLib.Approval[] memory archived = _guardianApprovals(digest);

        _schedule(account, address(token), transfer, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 3 days);
        account.executeScheduled(address(token), 0, transfer);
        require(token.balanceOf(address(0xCAFE)) == 50, "vault withdrawal did not execute");

        bytes32 secondId = _scheduleVaultWithdrawal(account, vault, address(token), 0, transfer);
        require(secondId == withdrawalId, "second withdrawal should reuse the slot");

        (bool replayed,) = address(vault)
            .call(
                abi.encodeCall(VaultHook.cancelVaultWithdrawalWithGuardians, (address(account), withdrawalId, archived))
            );
        require(!replayed, "approval for an executed withdrawal cancelled a later one");
        (uint48 stillPending,,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        require(stillPending != 0, "replay cleared the second withdrawal");
    }

    /// @notice An approval is bound to one account even when two accounts share a
    /// guardian set and hold an otherwise identical withdrawal.
    function testGuardianCancellationDoesNotCrossAccounts() public {
        (LoomAccount first, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(first), 100);
        _setPolicy(first, vault, address(token), 10, 1 days, 2 days);

        // A second account with the same guardian root and the same vault hook.
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vault), "");
        LoomAccount second =
            new LoomAccount(address(this), _guardianRoot(), 2, keccak256("vault-config-second"), modules);
        token.mint(address(second), 100);
        _setPolicy(second, vault, address(token), 10, 1 days, 2 days);

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes32 firstId = _scheduleVaultWithdrawal(first, vault, address(token), 0, transfer);
        bytes32 secondId = _scheduleVaultWithdrawal(second, vault, address(token), 0, transfer);
        require(firstId != secondId, "withdrawal identity must bind the account");

        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(first), firstId);
        bytes32 digest = vault.cancelWithdrawalDigest(address(first), firstId, version, nonce);
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(digest);

        (bool crossed,) = address(vault)
            .call(abi.encodeCall(VaultHook.cancelVaultWithdrawalWithGuardians, (address(second), secondId, approvals)));
        require(!crossed, "approvals for one account cancelled another account's withdrawal");
        (uint48 secondReady,,,) = vault.pendingWithdrawals(address(second), secondId);
        require(secondReady != 0, "cross-account replay cleared the pending withdrawal");
    }

    /// @notice Consuming one slot must not disturb another pending withdrawal.
    /// @dev This is why the counter is per slot rather than per account, unlike
    /// `RecoveryManager`: an account may hold many pending withdrawals at once, and
    /// a per-account counter would change every other withdrawal's identity.
    function testCancellingOneWithdrawalLeavesOtherPendingWithdrawalsExecutable() public {
        (LoomAccount account, VaultHook vault) = _accountWithVault(2);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 200);
        _setPolicy(account, vault, address(token), 10, 1 days, 2 days);

        bytes memory first = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 50));
        bytes memory second = abi.encodeCall(MockERC20.transfer, (address(0xF00D), 60));
        bytes32 firstId = _scheduleVaultWithdrawal(account, vault, address(token), 0, first);
        bytes32 secondId = _scheduleVaultWithdrawal(account, vault, address(token), 0, second);
        require(firstId != secondId, "distinct withdrawals must use distinct slots");

        (,, uint64 version, uint64 nonce) = vault.pendingWithdrawals(address(account), firstId);
        bytes32 digest = vault.cancelWithdrawalDigest(address(account), firstId, version, nonce);
        vault.cancelVaultWithdrawalWithGuardians(address(account), firstId, _guardianApprovals(digest));

        (uint48 secondReady,,, uint64 secondNonce) = vault.pendingWithdrawals(address(account), secondId);
        require(secondReady != 0, "unrelated withdrawal was cancelled");
        require(secondNonce == 0, "unrelated withdrawal's counter moved");

        _schedule(account, address(token), second, account.MIN_EXTERNAL_DELAY());
        vm.warp(block.timestamp + 3 days);
        account.executeScheduled(address(token), 0, second);
        require(token.balanceOf(address(0xF00D)) == 60, "unrelated withdrawal became unexecutable");
    }

    function _accountWithVault(uint8 guardianThreshold) internal returns (LoomAccount account, VaultHook vault) {
        MockValidator validator = new MockValidator();
        vault = new VaultHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vault), "");
        account = new LoomAccount(
            address(this),
            guardianThreshold == 1 ? _guardianLeaf() : _guardianRoot(),
            guardianThreshold,
            keccak256(abi.encode("vault-config", address(validator), guardianThreshold)),
            modules
        );
    }

    function _setPolicy(
        LoomAccount account,
        VaultHook vault,
        address asset,
        uint128 dailyLimit,
        uint48 period,
        uint48 delay
    ) internal {
        VaultHook.VaultPolicy memory policy = VaultHook.VaultPolicy(dailyLimit, period, delay, true);
        bytes memory data = abi.encodeCall(VaultHook.setVaultPolicy, (asset, policy));
        _schedule(account, address(vault), data, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vault), 0, data);
    }

    function _scheduleVaultWithdrawal(
        LoomAccount account,
        VaultHook vault,
        address target,
        uint256 value,
        bytes memory data
    ) internal returns (bytes32 withdrawalId) {
        withdrawalId = _scheduleVaultWithdrawalWindow(account, vault, target, value, data, 7 days);
    }

    function _scheduleVaultWithdrawalWindow(
        LoomAccount account,
        VaultHook vault,
        address target,
        uint256 value,
        bytes memory data,
        uint48 executionWindow
    ) internal returns (bytes32 withdrawalId) {
        bytes memory schedule =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (target, value, data, executionWindow));
        _schedule(account, address(vault), schedule, account.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vault), 0, schedule);
        withdrawalId = vault.withdrawalIdFor(address(account), target, value, keccak256(data), account.configVersion());
    }

    function _executeTransfer(LoomAccount account, MockERC20 token, address to, uint256 amount) internal {
        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (to, amount));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, transfer)));
    }

    function _schedule(LoomAccount account, address target, bytes memory data, uint48 delay) internal {
        _scheduleValue(account, target, 0, data, delay);
    }

    function _scheduleValue(LoomAccount account, address target, uint256 value, bytes memory data, uint48 delay)
        internal
    {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, value, data, delay));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
    }

    function _guardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _secondGuardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(SECOND_GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("second-guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _guardianRoot() internal returns (bytes32) {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        return first <= second ? keccak256(abi.encodePacked(first, second)) : keccak256(abi.encodePacked(second, first));
    }

    function _guardianApprovals(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        approvals = new GuardianVerificationLib.Approval[](2);
        if (first <= second) {
            approvals[0] = _approval(GUARDIAN_KEY, "guardian-salt", second, digest);
            approvals[1] = _approval(SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
        } else {
            approvals[0] = _approval(SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
            approvals[1] = _approval(GUARDIAN_KEY, "guardian-salt", second, digest);
        }
    }

    function _approval(uint256 privateKey, string memory saltText, bytes32 sibling, bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval memory approval)
    {
        address guardian = vm.addr(privateKey);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keccak256(abi.encode(guardian)),
            salt: keccak256(bytes(saltText)),
            signature: _signature(privateKey, digest),
            proof: proof
        });
    }

    function _signature(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    receive() external payable {}
}
