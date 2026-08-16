// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {RecoveryIntentBoard} from "../../src/recovery/RecoveryIntentBoard.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {RecoveryIntentBoardHarness} from "./RecoveryIntentBoardHarness.sol";

/// @notice A digest source under an attacker's control.
///
/// `publishApproval` takes the manager address from its caller, so this is what
/// a caller is free to pass instead of the real one.
contract HostileProposalSource {
    bytes32 public immutable digest;
    uint64 public immutable nonce;

    constructor(bytes32 digest_, uint64 nonce_) {
        digest = digest_;
        nonce = nonce_;
    }

    function proposalDigest(address, bytes32, address, bytes32, bytes32, uint8, uint64, uint64)
        external
        view
        returns (bytes32)
    {
        return digest;
    }

    function recoveryNonces(address) external view returns (uint64) {
        return nonce;
    }
}

/// @notice What an attacker can and cannot make the board do.
///
/// The board is a bulletin board: anyone may post, and posting is not
/// authority. These tests attack that claim from the directions where a
/// permissionless record usually fails -- a forged digest source, a second
/// deployment of the same contract, a threshold shortfall, and replay of a real
/// signature onto a different proposal.
///
/// Each one ends at `RecoveryManager`, because the board's own acceptance is
/// worth nothing on its own. The property under test is that no post changes
/// what the manager will do.
contract RecoveryIntentBoardAdversarialTest is RecoveryIntentBoardHarness {
    /// A caller chooses the manager address, so a caller can point the board at
    /// a contract that returns any digest it likes.
    ///
    /// This is the reason `publishApproval` checks that the named manager is the
    /// account's own installed recovery module. Without that check the digest
    /// comes from the attacker, and because the published identity is derived
    /// from the advertised parameters rather than from the manager, a post could
    /// carry the identity of a genuine recovery while its approval was verified
    /// against a digest nobody with authority ever defined -- filling a real
    /// request with approvals that mean nothing.
    function testTheDigestSourceMustBeTheAccountsOwnRecoveryModule() public {
        address[] memory validators = _sortedValidators();
        // A digest for a proposal handing the account to a validator the owner
        // never chose, while the post advertises the genuine one.
        bytes32 hostileDigest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(secondValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            account.configVersion(),
            0
        );
        HostileProposalSource hostile = new HostileProposalSource(hostileDigest, 0);
        require(
            !account.isModuleInstalled(ModuleType.RECOVERY, address(hostile)),
            "the hostile source must not be an installed module"
        );

        GuardianVerificationLib.Approval[] memory approvals =
            _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, hostileDigest));
        require(
            !_tryPublishVia(address(hostile), approvals),
            "the board accepted a digest from a contract the account never installed"
        );

        // The guard rejects an unauthorised source, not every post: the same
        // guardian publishing against the real manager still works.
        require(
            _tryPublish(
                _approval(
                    leafB,
                    address(guardianVerifier),
                    commitmentA,
                    saltA,
                    keyA,
                    _digest(validators, 0, account.configVersion())
                )
            ),
            "the guard also blocked a genuine post"
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "publishing created a pending recovery");
    }

    /// The same guard, from the other side: a real `RecoveryManager` is still
    /// the wrong source if this account did not install it. An account holds at
    /// most one recovery module, so there is exactly one answer.
    function testAnUninstalledManagerIsRejectedEvenThoughItIsGenuine() public {
        RecoveryManager other = new RecoveryManager();
        bytes32 theirs = other.proposalDigest(
            address(account),
            keccak256(abi.encode(_sortedValidators())),
            address(newValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            account.configVersion(),
            0
        );
        require(
            !_tryPublishVia(
                address(other), _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, theirs))
            ),
            "an uninstalled manager was accepted as a digest source"
        );
    }

    /// The digest binds the manager that produced it. Two deployments of the
    /// same contract are two different domains, so an approval collected for
    /// one cannot be replayed against the other. Without this, an account with
    /// a second manager installed could have its guardians' signatures moved.
    function testAnApprovalDoesNotCarryToASecondManagerDeployment() public {
        address[] memory validators = _sortedValidators();
        RecoveryManager other = new RecoveryManager();
        bytes32 mine = _digest(validators, 0, account.configVersion());
        bytes32 theirs = other.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(newValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            account.configVersion(),
            0
        );
        require(mine != theirs, "two manager deployments share a digest; the domain does not bind the contract");

        // A signature made for the other deployment cannot be published here.
        require(
            !_tryPublish(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, theirs)),
            "an approval for another manager was published against this one"
        );
    }

    /// The board verifies one approval at a time, against a threshold of one.
    /// That is a claim about a single signature's authenticity and nothing
    /// more; the account's real threshold is enforced where authority lives.
    function testPublishedApprovalsDoNotSatisfyTheAccountThreshold() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        require(account.guardianThreshold() == 2, "this test needs a threshold above one");

        GuardianVerificationLib.Approval[] memory single =
            _one(_approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest));
        require(_tryPublishMany(single), "a genuine single approval must be publishable");

        (bool proposed,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (address(account), validators, address(newValidator), keccak256(""), NEW_GUARDIAN_ROOT, 1, single)
                )
            );
        require(!proposed, "one published approval met a guardian threshold of two");
    }

    /// A real guardian signature, replayed onto a different proposal. Every
    /// field the board reports is in the digest, so changing any one of them
    /// leaves the signature verifying nothing.
    function testAnApprovalCannotBeReplayedOntoADifferentProposal() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        GuardianVerificationLib.Approval memory genuine =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);
        require(_tryPublish(genuine), "the approval must be genuine for the replay to mean anything");

        // Same signature, re-posted for a proposal naming a different validator.
        (bool replayed,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(account),
                        address(recovery),
                        keccak256(abi.encode(validators)),
                        address(secondValidator),
                        keccak256(""),
                        NEW_GUARDIAN_ROOT,
                        1,
                        _one(genuine)
                    )
                )
            );
        require(!replayed, "a guardian approval was replayed onto a different validator");
    }

    /// Changing the guardian root the recovery rotates to is the same replay
    /// with a subtler payload: the account looks recovered to its owner while
    /// the attacker holds the new guardian set.
    function testAnApprovalCannotBeReplayedOntoADifferentGuardianRoot() public {
        address[] memory validators = _sortedValidators();
        bytes32 digest = _digest(validators, 0, account.configVersion());
        GuardianVerificationLib.Approval memory genuine =
            _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);

        (bool replayed,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(account),
                        address(recovery),
                        keccak256(abi.encode(validators)),
                        address(newValidator),
                        keccak256(""),
                        keccak256("attacker-guardian-root"),
                        1,
                        _one(genuine)
                    )
                )
            );
        require(!replayed, "a guardian approval was replayed onto a different guardian root");
    }

    function _tryPublishVia(address manager, GuardianVerificationLib.Approval[] memory approvals)
        internal
        returns (bool ok)
    {
        (ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(account),
                        manager,
                        keccak256(abi.encode(_sortedValidators())),
                        address(newValidator),
                        keccak256(""),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
    }
}
