// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {GuardianVerificationLib} from "../src/libraries/GuardianVerificationLib.sol";
import {EIP712Lib} from "../src/libraries/EIP712Lib.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {ReentrantHook} from "./mocks/ReentrantHook.sol";
import {RevertingHook} from "./mocks/RevertingHook.sol";
import {GasGriefingHook} from "./mocks/GasGriefingHook.sol";
import {StorageModifyingHook} from "./mocks/StorageModifyingHook.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial Hooks — Phase 7 of the verification plan
//
// Each test here verifies that a malicious or faulty hook cannot:
//   1. Block legitimate scheduled removal of the hook itself
//   2. Compromise the account via reentrancy
//   3. Corrupt state via storage writes from a hook context
//   4. Prevent guardian-threshold eviction
//   5. Block execution by consuming extreme amounts of gas
//
// WHY: Hooks gate every ordinary execute() call. A compromised or buggy hook
// must never leave the account in an unrecoverable state. The scheduled
// removal path (MIN_CONFIG_DELAY) and guardian eviction path
// (evictHookWithGuardians) must remain reachable regardless of hook behavior.
// ─────────────────────────────────────────────────────────────────────────────

interface VmMalicious {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract MaliciousHookTest {
    VmMalicious internal constant vm = VmMalicious(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    ECDSAGuardianVerifier internal guardianVerifier = new ECDSAGuardianVerifier();

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _accountWithHook(address hook)
        internal
        returns (LoomAccount account, MockValidator validator, MockTarget target)
    {
        validator = new MockValidator();
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("salt");
        bytes32 leaf =
            keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, hook, "");
        account = new LoomAccount(address(this), leaf, 1, keccak256("config"), modules);
        target = new MockTarget();
    }

    function _guardianApprovals(
        address,
        /* account */
        bytes32 digest
    )
        internal
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("salt");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keyCommitment,
            salt: salt,
            signature: sig,
            proof: new bytes32[](0)
        });
    }

    function _scheduleHookRemoval(LoomAccount account, address hook) internal returns (bytes32 operationId) {
        bytes memory uninstall = abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, hook, bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        operationId = keccak256(abi.encode(address(account), uint256(0), uninstall, account.configVersion()));
    }

    // ─── Test 1: Reverting hook blocks execute but NOT scheduled removal ───────

    /// @notice A hook that always reverts in preCheck must not prevent its own
    ///         removal. The scheduled uninstall path sets _isHookRemovalExecution
    ///         = true, which bypasses pre/postCheck for the hook.
    ///
    /// WHY: Without this, a compromised or self-destructing hook would be
    /// permanent — the account would become permanently unable to execute.
    function testRevertingHookCanBeRemovedViaSchedule() public {
        RevertingHook hook = new RevertingHook();
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));

        // Verify the hook blocks ordinary execution.
        bytes memory normalExec = abi.encodeCall(
            LoomAccount.execute,
            (
                bytes32(0),
                abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1))))
            )
        );
        (bool blockedByHook,) = address(account).call(normalExec);
        require(!blockedByHook, "reverting hook must block execute");
        require(target.value() == 0, "execute must be a no-op when hook reverts");

        // Schedule removal, bypassing the reverting hook.
        _scheduleHookRemoval(account, address(hook));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        // Execute the scheduled removal — this bypasses preCheck.
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), bytes("")));
        account.executeScheduled(address(account), 0, uninstall);

        // Verify hook is gone and normal execution works again.
        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook must be uninstalled");
        account.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (42))))
        );
        require(target.value() == 42, "execution must succeed after hook removal");
    }

    // ─── Test 2: Reverting hook can be immediately evicted by guardians ────────

    /// @notice Guardian threshold can evict a reverting hook immediately,
    ///         without waiting for the MIN_CONFIG_DELAY schedule.
    ///
    /// WHY: The guardian eviction path exists specifically because a blocking
    /// hook forces users to wait MIN_CONFIG_DELAY (3 days). If the hook is
    /// hostile and the user has configured guardians, they should not have to
    /// wait 3 days — reaching guardian consensus is itself the security bar.
    function testRevertingHookCanBeEvictedByGuardians() public {
        RevertingHook hook = new RevertingHook();
        (LoomAccount account,,) = _accountWithHook(address(hook));

        bytes32 digest = account.evictHookDigest(address(hook), account.configVersion());
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(address(account), digest);
        account.evictHookWithGuardians(address(hook), approvals);

        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook must be evicted");
    }

    // ─── Test 3: Reentrant hook is blocked by execution lock ─────────────────

    /// @notice A hook that tries to re-enter execute() during preCheck must be
    ///         blocked by the _executionLocked guard, not allowed to re-execute.
    ///
    /// WHY: If reentrancy from a hook were possible, the hook could double-spend
    /// vault limits, re-trigger execution while state is partially updated, or
    /// bypass any authorization that depends on call context.
    function testReentrantHookInPreCheckIsBlocked() public {
        ReentrantHook hook = new ReentrantHook();
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));
        hook.setReenterOnPreCheck(true);

        // This should succeed (the hook's reentry fails) but not reenter.
        account.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (99))))
        );

        require(!hook.reenteredInPreCheck(), "reentrancy in preCheck must be blocked");
        require(target.value() == 99, "outer execution must succeed");
    }

    /// @notice A hook that tries to re-enter execute() during postCheck must
    ///         similarly be blocked.
    function testReentrantHookInPostCheckIsBlocked() public {
        ReentrantHook hook = new ReentrantHook();
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));
        hook.setReenterOnPostCheck(true);

        account.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (77))))
        );

        require(!hook.reenteredInPostCheck(), "reentrancy in postCheck must be blocked");
        require(target.value() == 77, "outer execution must succeed");
    }

    // ─── Test 4: Gas-griefing hook cannot prevent scheduled removal ───────────

    /// @notice A hook that consumes nearly all gas in preCheck must not prevent
    ///         the scheduled removal from executing (which bypasses preCheck).
    ///
    /// WHY: If a hook consumed all gas during preCheck, the _scheduleHookRemoval
    /// call itself (which triggers preCheck) would fail. But _scheduleHookRemoval
    /// calls scheduleCall (not execute), which schedules but doesn't run preCheck.
    /// The executeScheduled call on a hook-removal schedule bypasses hooks.
    function testGasGriefingHookCanBeRemovedViaSchedule() public {
        // Use a modest gas burn — enough to verify the bypass logic, not enough
        // to actually make tests run out of gas in the testing framework.
        GasGriefingHook hook = new GasGriefingHook(100_000);
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));

        // Verify the hook slows down ordinary execution.
        uint256 gasBefore = gasleft();
        account.execute(
            bytes32(0), abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1))))
        );
        uint256 gasAfter = gasleft();
        require(gasBefore - gasAfter > 50_000, "gas griefing hook must have consumed gas");

        // Schedule hook removal (this schedules via scheduleCall; preCheck runs
        // for the schedule-call wrapper but NOT for uninstallModule target).
        // NOTE: The scheduleCall wrapper is EXECUTE-mode, preCheck fires,
        // but the hook's preCheck returns "" on schedule calls (not revert).
        // The hook only grips gas on preCheck. The actual removal bypasses hooks.
        _scheduleHookRemoval(account, address(hook));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), bytes("")));
        account.executeScheduled(address(account), 0, uninstall);

        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook must be removed");
    }

    // ─── Test 5: Storage-modifying hook cannot compromise account state ────────

    /// @notice A hook that writes to its own storage during preCheck and
    ///         attempts reentrancy must not succeed in the reentry.
    ///         The hook's storage writes land in the hook contract, not the account.
    ///
    /// WHY: Since hooks are called via CALL (not DELEGATECALL), they write to
    /// their own storage space. This test confirms that the hook's state changes
    /// are isolated and that the account's own storage is never accessible via
    /// a hook-initiated reentry.
    function testStorageModifyingHookCannotCompromiseAccount() public {
        StorageModifyingHook hook = new StorageModifyingHook();
        hook.setAttemptReentryOnPreCheck(true);
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));

        account.execute(
            bytes32(0), abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (5))))
        );

        // Hook's own storage incremented.
        require(hook.preCheckWriteCount() == 1, "hook storage write must land in hook");
        // Reentrancy was blocked.
        require(!hook.reentrySucceededInPreCheck(), "hook reentry must be blocked");
        // Account state is correct.
        require(target.value() == 5, "account execution must succeed");
    }

    function testStorageModifyingHookPostCheckCannotReenter() public {
        StorageModifyingHook hook = new StorageModifyingHook();
        hook.setAttemptReentryOnPostCheck(true);
        (LoomAccount account,, MockTarget target) = _accountWithHook(address(hook));

        account.execute(
            bytes32(0), abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (6))))
        );

        require(!hook.reentrySucceededInPostCheck(), "post-check reentry must be blocked");
        require(target.value() == 6, "execution must succeed");
    }

    // ─── Test 6: Hook eviction preserves configVersion monotonicity ───────────

    /// @notice After guardian eviction, configVersion must have increased exactly
    ///         once, and configHash must have changed.
    ///
    /// WHY: evictHookWithGuardians calls _advanceConfig, which must increment
    /// configVersion. Any test that checks "config never decreases" must also
    /// verify that administrative actions (evictions) correctly advance it.
    function testHookEvictionAdvancesConfigVersion() public {
        RevertingHook hook = new RevertingHook();
        (LoomAccount account,,) = _accountWithHook(address(hook));

        uint64 versionBefore = account.configVersion();
        bytes32 hashBefore = account.configHash();

        bytes32 digest = account.evictHookDigest(address(hook), account.configVersion());
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(address(account), digest);
        account.evictHookWithGuardians(address(hook), approvals);

        require(account.configVersion() == versionBefore + 1, "eviction must advance configVersion exactly once");
        require(account.configHash() != hashBefore, "eviction must change configHash");
    }

    // ─── Test 7: Multiple hook evictions in sequence ──────────────────────────

    /// @notice With two reverting hooks, both can be evicted in sequence.
    ///         Each eviction independently requires guardian approval with the
    ///         current configVersion at time of eviction.
    ///
    /// WHY: Verifies that eviction is idempotent across multiple hooks and
    ///      that the configVersion binding in evictHookDigest prevents replaying
    ///      an old eviction approval for a newly installed hook.
    function testSequentialHookEvictionsAreIndependent() public {
        RevertingHook hook1 = new RevertingHook();
        RevertingHook hook2 = new RevertingHook();

        MockValidator validator = new MockValidator();
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("salt");
        bytes32 leaf =
            keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook1), "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook2), "");
        LoomAccount account = new LoomAccount(address(this), leaf, 1, keccak256("two-hook-config"), modules);

        uint64 v1 = account.configVersion();

        // Evict hook1 at configVersion v1.
        {
            bytes32 digest1 = account.evictHookDigest(address(hook1), v1);
            GuardianVerificationLib.Approval[] memory a1 = _guardianApprovals(address(account), digest1);
            account.evictHookWithGuardians(address(hook1), a1);
        }
        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook1)), "hook1 must be evicted");
        require(account.configVersion() == v1 + 1, "version must advance after hook1 eviction");

        // Evict hook2 at configVersion v1+1. A replay of the v1 digest must fail.
        {
            bytes32 staleDigest = account.evictHookDigest(address(hook2), v1); // stale version
            GuardianVerificationLib.Approval[] memory staleApprovals = _guardianApprovals(address(account), staleDigest);
            (bool staleOk,) = address(account)
                .call(abi.encodeCall(LoomAccount.evictHookWithGuardians, (address(hook2), staleApprovals)));
            require(!staleOk, "stale eviction digest must be rejected");

            bytes32 freshDigest = account.evictHookDigest(address(hook2), account.configVersion());
            GuardianVerificationLib.Approval[] memory freshApprovals = _guardianApprovals(address(account), freshDigest);
            account.evictHookWithGuardians(address(hook2), freshApprovals);
        }
        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook2)), "hook2 must be evicted");
        require(account.configVersion() == v1 + 2, "version must advance after hook2 eviction");
    }

    // ─── Test 8: Hook eviction during frozen account ──────────────────────────

    /// @notice Guardian-threshold hook eviction must work even when the account
    ///         is frozen, because evictHookWithGuardians does not check frozenUntil.
    ///
    /// WHY: The freeze is a mechanism for guardians to buy time. If a guardian
    ///      froze the account to block a bad actor but also needed to evict a
    ///      compromised hook, that eviction must remain possible. The freeze
    ///      only blocks execute() and executeMigration(), not guardian admin ops.
    function testHookEvictionIsPermittedWhileFrozen() public {
        RevertingHook hook = new RevertingHook();
        (LoomAccount account,,) = _accountWithHook(address(hook));

        // Freeze the account.
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("salt");
        bytes32[] memory proof = new bytes32[](0);
        bytes32 leaf = account.guardianLeaf(address(guardianVerifier), keyCommitment, salt);
        bytes32 freezeStructHash =
            keccak256(abi.encode(account.FREEZE_TYPEHASH(), leaf, account.freezeNonces(leaf), account.configVersion()));
        bytes32 domainSep = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(),
                keccak256("LoomAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 freezeDigest = keccak256(abi.encodePacked("\x19\x01", domainSep, freezeStructHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, freezeDigest);
        account.freeze(address(guardianVerifier), keyCommitment, salt, proof, abi.encodePacked(r, s, v));
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < account.frozenUntil(), "account must be frozen");

        // Evict hook while frozen — this must succeed.
        bytes32 evictDigest = account.evictHookDigest(address(hook), account.configVersion());
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(address(account), evictDigest);
        account.evictHookWithGuardians(address(hook), approvals);

        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook must be evicted while frozen");
    }

    // ─── Test 9: Hook eviction does not affect scheduled operations ───────────

    /// @notice Evicting a hook must not cancel or alter pending scheduled
    ///         operations. The operationId is keyed on (target, value, data,
    ///         configVersion), and configVersion advances during eviction, so
    ///         any operations scheduled at the old configVersion become
    ///         permanently stale (they will revert with OperationNotScheduled).
    ///
    /// WHY: This is the expected and desired behavior — if a hook eviction
    ///      changes configVersion, any scheduled op from before the eviction
    ///      is implicitly invalidated because the system state changed. Users
    ///      must re-schedule ops after a guardian-eviction event.
    function testHookEvictionInvalidatesOldScheduledOps() public {
        RevertingHook hook = new RevertingHook();
        (,, MockTarget target) = _accountWithHook(address(hook));

        // We cannot schedule via execute() because the hook reverts it.
        // So we use the hook-bypass path: schedule a hook-removal-like op.
        // Instead, let's install a non-reverting hook first so we can schedule.
        // This tests: schedule op at v1, evict reverting-hook (raises to v2),
        // try to execute op at v1 key — must fail.

        // For this test, we'll directly call scheduleCall via `this` (the test
        // contract is the account's entry point). scheduleCall is onlySelf, so
        // we need to route through execute().
        // The reverting hook blocks execute(). So we test the stale-op invariant
        // via the guardian migration cancel path as a proxy.
        // Use a fresh account with a non-reverting hook.
        StorageModifyingHook safeHook = new StorageModifyingHook();
        MockValidator validator2 = new MockValidator();
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("salt");
        bytes32 leaf =
            keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
        LoomAccount.ModuleInit[] memory mods = new LoomAccount.ModuleInit[](3);
        mods[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator2), "");
        mods[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        mods[2] = LoomAccount.ModuleInit(ModuleType.HOOK, address(safeHook), "");
        LoomAccount account2 = new LoomAccount(address(this), leaf, 1, keccak256("two-hooks-with-safe"), mods);

        // Schedule an external call via the safe hook (which lets execute pass).
        bytes memory externalCall = abi.encodeCall(MockTarget.setValue, (42));
        // execute() runs preCheck on BOTH hooks; reverting hook will block this.
        // Instead, skip to just the invariant: after configVersion changes,
        // the old scheduled op key is gone.
        // Schedule directly by calling from the account's entrypoint (this).
        // scheduleCall is onlySelf — we'd need to route via execute().
        // Since hook1 reverts, use the hook-bypass to remove it first, then schedule.

        // Step 1: Evict the reverting hook (hook) at v1.
        uint64 v1 = account2.configVersion();
        {
            bytes32 d = account2.evictHookDigest(address(hook), v1);
            account2.evictHookWithGuardians(address(hook), _guardianApprovals(address(account2), d));
        }
        // Now configVersion == v1+1; safe hook remains.

        // Step 2: Schedule an op at the new configVersion.
        account2.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(account2),
                    0,
                    abi.encodeCall(
                        LoomAccount.scheduleCall, (address(target), 0, externalCall, account2.MIN_EXTERNAL_DELAY())
                    )
                )
            )
        );

        // operationId is keyed on (target, 0, externalCall, currentConfigVersion).
        bytes32 opId = keccak256(abi.encode(address(target), uint256(0), externalCall, account2.configVersion()));
        require(account2.scheduledOperations(opId) != 0, "operation must be scheduled");

        // Step 3: Evict the safe hook — configVersion advances again.
        {
            bytes32 d = account2.evictHookDigest(address(safeHook), account2.configVersion());
            account2.evictHookWithGuardians(address(safeHook), _guardianApprovals(address(account2), d));
        }

        // Now the old opId is stale (it was computed before the second eviction).
        // The executeScheduled uses the CURRENT configVersion in the key — so
        // the previously-scheduled op is now invalid.
        vm.warp(block.timestamp + account2.MIN_EXTERNAL_DELAY());
        (bool execOk,) =
            address(account2).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, externalCall)));
        // IMPORTANT: This SHOULD succeed because executeScheduled uses configVersion
        // at time of call, and the opId stored IS for the current version IF the
        // op was scheduled after the last configVersion change. This test verifies
        // the correct invalidation behavior documented in ARCHITECTURE.md.
        // The test above scheduled the op after the first eviction (v1+1), then
        // evicted safeHook (v1+2). So the op scheduled at v1+1 is stale.
        require(!execOk, "op scheduled at stale configVersion must be rejected by executeScheduled");
    }
}
