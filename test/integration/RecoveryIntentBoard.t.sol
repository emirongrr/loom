// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {RecoveryIntentBoard} from "../../src/recovery/RecoveryIntentBoard.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {RecoveryIntentBoardHarness} from "./RecoveryIntentBoardHarness.sol";

/// @notice `RecoveryIntentBoard` must let guardian approvals accumulate across
/// separate transactions without becoming an authority. Every test here asserts
/// one of two things: that an approval published on the board is exactly what
/// `RecoveryManager` will independently accept, or that the board cannot reach
/// @notice `RecoveryIntentBoard` must let guardian approvals accumulate across
/// separate transactions without becoming an authority. Every test here asserts
/// one of two things: that an approval published on the board is exactly what
/// `RecoveryManager` will independently accept, or that the board cannot reach
/// account or recovery state at all.
contract RecoveryIntentBoardTest is RecoveryIntentBoardHarness {
    // --- The behaviour the board exists for ---------------------------------

    /// Two guardians publish in separate transactions; an unrelated third party
    /// reassembles both and proposes. This is the whole point of the record.
    function testApprovalsPublishedSeparatelyAssembleIntoAValidProposal() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());

        bytes32 idFromA = _publish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        bytes32 idFromB = _publish(_approval(leafA, address(guardianVerifier), commitmentB, saltB, keyB, digest));
        require(idFromA == idFromB, "separate approvals produced different recovery ids");

        // Nothing authoritative has happened yet: publication is not proposal.
        (,,,,, uint48 readyAtBefore,,,) = recovery.pendingRecoveries(address(account));
        require(readyAtBefore == 0, "publishing an approval created a pending recovery");

        GuardianVerificationLib.Approval[] memory bundle = _bundle(digest);
        recovery.proposeRecovery(
            address(account), validators, address(newValidator), keccak256(""), NEW_GUARDIAN_ROOT, 1, bundle
        );

        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt != 0, "reassembled approvals were rejected by the manager");
        require(
            recovery.recoveryIdFor(address(account), _pending()) == idFromA, "board and manager disagree on identity"
        );
    }

    /// The board must derive the digest from the manager, not invent one, or a
    /// published approval would not satisfy `proposeRecovery`.
    function testPublishedApprovalUsesTheManagerDigest() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        // A signature over any other digest cannot be published.
        require(
            !_tryPublish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, keccak256("other"))),
            "board accepted a signature over a foreign digest"
        );
        require(
            _tryPublish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest)),
            "board rejected the manager digest"
        );
    }

    // --- Who may publish ----------------------------------------------------

    function testPublishApprovalRejectsANonGuardian() public {
        bytes32 digest = _digest(_sortedValidators(), 0, account.configVersion());
        GuardianVerificationLib.Approval memory forged = _approval(
            leafB, address(guardianVerifier), keccak256(abi.encode(vm.addr(OUTSIDER_KEY))), saltA, OUTSIDER_KEY, digest
        );
        require(!_tryPublish(forged), "a non-guardian published an approval");
    }

    function testPublishApprovalRejectsMoreThanOneApproval() public {
        bytes32 digest = _digest(_sortedValidators(), 0, account.configVersion());
        require(!_tryPublishMany(_bundle(digest)), "board accepted a multi-guardian batch");
    }

    function testPublishApprovalRejectsAnOversizedSignature() public {
        bytes32 digest = _digest(_sortedValidators(), 0, account.configVersion());
        GuardianVerificationLib.Approval memory oversized =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);
        oversized.signature = new bytes(board.MAX_SIGNATURE_BYTES() + 1);
        require(!_tryPublish(oversized), "board accepted an unbounded signature into log data");
    }

    // --- Freshness is read from chain, never from the caller -----------------

    function testPublishApprovalRejectsAStaleConfigVersion() public {
        uint64 staleVersion = account.configVersion();
        bytes32 staleDigest = _digest(_sortedValidators(), 0, staleVersion);
        GuardianVerificationLib.Approval memory approval =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, staleDigest);
        require(_tryPublish(approval), "approval was not publishable before the configuration changed");

        _advanceConfigVersion();
        require(account.configVersion() != staleVersion, "configuration version did not advance");
        require(!_tryPublish(approval), "board published an approval bound to a stale configuration version");
    }

    function testPublishApprovalRejectsAStaleRecoveryNonce() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        GuardianVerificationLib.Approval memory approval =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);
        require(_tryPublish(approval), "approval was not publishable at nonce zero");

        recovery.proposeRecovery(
            address(account), validators, address(newValidator), keccak256(""), NEW_GUARDIAN_ROOT, 1, _bundle(digest)
        );
        // Cancellation needs the account itself plus guardian support, and it
        // advances the recovery nonce without touching the guardian root, which
        // isolates the nonce as the only thing that changed.
        RecoveryManager.PendingRecovery memory pending = _pending();
        bytes32 cancelDigest = recovery.cancelDigest(
            address(account), recovery.recoveryIdFor(address(account), pending), pending.configVersion, pending.nonce
        );
        GuardianVerificationLib.Approval[] memory cancelApprovals =
            _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, cancelDigest));
        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(recovery),
                    0,
                    abi.encodeCall(
                        RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), cancelApprovals)
                    )
                )
            )
        );
        require(recovery.recoveryNonces(address(account)) == 1, "recovery nonce did not advance");
        require(account.guardianRoot() == guardianRoot, "cancellation changed the guardian root");
        require(!_tryPublish(approval), "board published an approval bound to a spent recovery nonce");
    }

    function testPublishApprovalRejectsAnApprovalForAnotherAccount() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        GuardianVerificationLib.Approval memory approval =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount other = new LoomAccount(address(this), guardianRoot, 2, keccak256("config"), modules);

        (bool ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(other),
                        address(recovery),
                        keccak256(abi.encode(validators)),
                        address(newValidator),
                        keccak256(""),
                        NEW_GUARDIAN_ROOT,
                        1,
                        _one(approval)
                    )
                )
            );
        require(!ok, "an approval for one account was published against another");
    }

    // --- The board is not an authority --------------------------------------

    /// Even granted the board's own identity as caller, it reaches nothing. This
    /// is the record's authority claim stated as an executable assertion rather
    /// than as an argument about which functions were omitted.
    function testBoardCannotReachAccountOrRecoveryStateEvenAsCaller() public {
        address[] memory validators = _sortedValidators();
        require(
            !account.isModuleInstalled(ModuleType.RECOVERY, address(board)), "board is installed as a recovery module"
        );

        vm.prank(address(board));
        (bool recovered,) = address(account)
            .call(
                abi.encodeWithSignature(
                    "recoverConfiguration(address[],address,bytes,bytes32,uint8)",
                    validators,
                    address(newValidator),
                    "",
                    NEW_GUARDIAN_ROOT,
                    uint8(1)
                )
            );
        require(!recovered, "an uninstalled board reached recoverConfiguration");

        // The legacy entry point reverts for every caller, so it proves little on
        // its own. The live cancellation paths are the ones worth pinning.
        // The legacy `cancelRecovery` entry point reverts for every caller, so it
        // proves nothing about this contract. Pin the live cancellation paths.
        vm.prank(address(board));
        (bool cancelled,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.cancelRecoveryWithAccountAndGuardians,
                    (address(account), new GuardianVerificationLib.Approval[](0))
                )
            );
        require(!cancelled, "the board cancelled a recovery as the account");

        vm.prank(address(board));
        (bool byGuardians,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.cancelRecoveryWithGuardians,
                    (address(account), new GuardianVerificationLib.Approval[](0))
                )
            );
        require(!byGuardians, "the board cancelled a recovery as a guardian");

        vm.prank(address(board));
        (bool asGuardian,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.cancelRecoveryWithGuardians,
                    (address(account), new GuardianVerificationLib.Approval[](0))
                )
            );
        require(!asGuardian, "the board cancelled a recovery as a guardian");
    }

    /// The record's central claim: zero storage variables, so there is no
    /// permissionless state to grow, corrupt, or migrate.
    /// The bytecode gate (`tools/quality/validate-no-storage-writes.mjs`) proves
    /// no storage-writing opcode exists in the deployed board. This proves the
    /// same thing from the other end, by watching a real execution: reading a
    /// fixed range of slots would only cover the slots a reader thought to
    /// check, whereas the recorder reports every write the call actually made.
    ///
    /// Both are here because neither alone is enough. `storage:check` is not a
    /// substitute for either: it permits appending, so a board that gained its
    /// first slot would pass it unchanged.
    function testNeitherEntryPointWritesAnySlot() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());

        vm.record();
        _announce(uint48(block.timestamp + ANNOUNCEMENT_EXPIRY));
        _publish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        _publish(_approval(leafA, address(guardianVerifier), commitmentB, saltB, keyB, digest));
        (, bytes32[] memory writes) = vm.accesses(address(board));

        require(writes.length == 0, "the board wrote a storage slot");
    }

    function testBoardWritesNoStorage() public {
        bytes32 digest = _digest(_sortedValidators(), 0, account.configVersion());
        _announce(ANNOUNCEMENT_EXPIRY);
        _publish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        _publish(_approval(leafA, address(guardianVerifier), commitmentB, saltB, keyB, digest));

        for (uint256 slot; slot < 8; ++slot) {
            require(vm.load(address(board), bytes32(slot)) == bytes32(0), "board wrote storage");
        }
    }

    // --- Announcements are inert --------------------------------------------

    function testAnnouncementFloodChangesNoAuthoritativeState() public {
        uint64 versionBefore = account.configVersion();
        uint64 nonceBefore = recovery.recoveryNonces(address(account));
        bytes32 rootBefore = account.guardianRoot();

        for (uint48 i; i < 32; ++i) {
            _announce(ANNOUNCEMENT_EXPIRY + i);
        }

        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "an announcement created a pending recovery");
        require(account.configVersion() == versionBefore, "an announcement advanced the configuration version");
        require(recovery.recoveryNonces(address(account)) == nonceBefore, "an announcement advanced the recovery nonce");
        require(account.guardianRoot() == rootBefore, "an announcement changed the guardian root");
        require(account.validatorCount() == 2, "an announcement changed the validator set");
    }

    function testUnverifiedAnnouncementCannotBlockLegitimateRecovery() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        for (uint48 i; i < 8; ++i) {
            _announce(ANNOUNCEMENT_EXPIRY + i);
        }

        recovery.proposeRecovery(
            address(account), validators, address(newValidator), keccak256(""), NEW_GUARDIAN_ROOT, 1, _bundle(digest)
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt != 0, "announcements blocked a legitimate proposal");

        vm.warp(readyAt);
        recovery.executeRecovery(address(account), validators, "");
        require(
            account.validatorCount() == 1 && account.validatorAt(0) == address(newValidator),
            "recovery did not complete"
        );
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root was not rotated");
    }
}
