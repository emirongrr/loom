// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {RecoveryIntentBoard} from "../../src/recovery/RecoveryIntentBoard.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {RecoveryIntentBoardHarness} from "./RecoveryIntentBoardHarness.sol";

/// @notice Cancelling a recovery must be assemblable the same way proposing one
/// is. Without a publication route, every cancellation signature has to reach a
/// single device, and a quorum that cannot assemble is a quorum that cannot
/// act -- while the recovery's delay keeps running.
///
/// Every test here asserts one of two things: that a cancellation published on
/// the board is exactly what `RecoveryManager` will independently accept, or
/// that the board refuses to publish something the manager would not.
contract RecoveryIntentBoardCancellationTest is RecoveryIntentBoardHarness {
    function _propose() internal returns (bytes32 recoveryId) {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        recovery.proposeRecovery(
            address(account), validators, address(newValidator), keccak256(""), NEW_GUARDIAN_ROOT, 1, _bundle(digest)
        );
        return recovery.recoveryIdFor(address(account), _pending());
    }

    function _cancelDigest(bytes32 recoveryId) internal view returns (bytes32) {
        (,,,,,,, uint64 configVersion, uint64 nonce) = recovery.pendingRecoveries(address(account));
        return recovery.cancelDigest(address(account), recoveryId, configVersion, nonce);
    }

    function _publishCancellation(GuardianVerificationLib.Approval memory approval) internal returns (bytes32) {
        return board.publishCancellation(address(account), address(recovery), _one(approval));
    }

    function _tryPublishCancellation(GuardianVerificationLib.Approval[] memory approvals) internal returns (bool ok) {
        (ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishCancellation, (address(account), address(recovery), approvals)
                )
            );
    }

    // --- The behaviour this exists for --------------------------------------

    /// Two guardians publish in separate transactions; an unrelated third party
    /// reassembles both and cancels. Neither guardian had to reach the other.
    function testCancellationsPublishedSeparatelyAssembleIntoAValidCancellation() public {
        bytes32 recoveryId = _propose();
        bytes32 digest = _cancelDigest(recoveryId);

        bytes32 idFromA =
            _publishCancellation(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        bytes32 idFromB =
            _publishCancellation(_approval(leafA, address(guardianVerifier), commitmentB, saltB, keyB, digest));
        require(idFromA == recoveryId, "board named a different recovery than the manager holds");
        require(idFromA == idFromB, "separate cancellations produced different recovery ids");

        // Publication is not cancellation: the recovery is still pending.
        (,,,,, uint48 readyAtBefore,,,) = recovery.pendingRecoveries(address(account));
        require(readyAtBefore != 0, "publishing a cancellation cancelled the recovery");

        GuardianVerificationLib.Approval[] memory bundle = _bundle(digest);
        recovery.cancelRecoveryWithGuardians(address(account), bundle);

        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "reassembled cancellations were rejected by the manager");
    }

    /// The digest must come from the manager, not from the board's own idea of
    /// one, or a published signature would not satisfy `cancelRecoveryWith...`.
    function testPublishedCancellationUsesTheManagerCancelDigest() public {
        bytes32 recoveryId = _propose();
        bytes32 proposalDigest = _digest(_sortedValidators(), 0, account.configVersion());
        bytes32 cancelDigest = _cancelDigest(recoveryId);
        require(cancelDigest != proposalDigest, "cancel and propose share a digest");

        // A signature over the proposal digest is a guardian saying the
        // opposite thing. The board must not take it for a cancellation.
        require(
            !_tryPublishCancellation(
                _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, proposalDigest))
            ),
            "an approval signature was accepted as a cancellation"
        );
        require(
            _tryPublishCancellation(
                _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, cancelDigest))
            ),
            "a valid cancellation was refused"
        );
    }

    // --- What it must refuse ------------------------------------------------

    /// There is nothing to object to before a recovery exists, and a signature
    /// published then would name a recovery id nobody can act on.
    function testPublishCancellationRejectsWhenNothingIsPending() public {
        bytes32 digest = _cancelDigest(bytes32(0));
        require(
            !_tryPublishCancellation(
                _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest))
            ),
            "a cancellation was published with no pending recovery"
        );
    }

    function testPublishCancellationRejectsANonGuardian() public {
        bytes32 digest = _cancelDigest(_propose());
        require(
            !_tryPublishCancellation(
                _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, 0xC0FFEE, digest))
            ),
            "a non-guardian cancellation was published"
        );
    }

    function testPublishCancellationRejectsMoreThanOneApproval() public {
        bytes32 digest = _cancelDigest(_propose());
        require(!_tryPublishCancellation(_bundle(digest)), "a bundle was published as one cancellation");
    }

    function testPublishCancellationRejectsAnOversizedSignature() public {
        bytes32 digest = _cancelDigest(_propose());
        GuardianVerificationLib.Approval memory approval =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);
        approval.signature = new bytes(board.MAX_SIGNATURE_BYTES() + 1);
        require(!_tryPublishCancellation(_one(approval)), "an oversized cancellation signature was published");
    }

    /// The manager is read from what the account installed, so a caller cannot
    /// name a contract of their own that would define the digest for them.
    function testPublishCancellationRejectsAnUnknownRecoveryManager() public {
        bytes32 digest = _cancelDigest(_propose());
        RecoveryManager stranger = new RecoveryManager();
        (bool ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishCancellation,
                    (
                        address(account),
                        address(stranger),
                        _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest))
                    )
                )
            );
        require(!ok, "a cancellation was published against a manager the account never installed");
    }

    /// Publishing must stay a log. If it could write, it could withhold or
    /// corrupt the record the manager depends on.
    function testPublishingACancellationWritesNoStorage() public {
        bytes32 digest = _cancelDigest(_propose());
        vm.record();
        _publishCancellation(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        (, bytes32[] memory boardWrites) = vm.accesses(address(board));
        (, bytes32[] memory managerWrites) = vm.accesses(address(recovery));
        require(boardWrites.length == 0, "the board wrote storage");
        require(managerWrites.length == 0, "publishing wrote to the recovery manager");
    }
}
