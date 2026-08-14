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

interface VmBoard {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function warp(uint256) external;
    function prank(address sender) external;
}

/// @notice `RecoveryIntentBoard` must let guardian approvals accumulate across
/// separate transactions without becoming an authority. Every test here asserts
/// one of two things: that an approval published on the board is exactly what
/// `RecoveryManager` will independently accept, or that the board cannot reach
/// account or recovery state at all.
contract RecoveryIntentBoardTest {
    VmBoard internal constant vm = VmBoard(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_A_KEY = 0xA11CE;
    uint256 internal constant GUARDIAN_B_KEY = 0xB0B;
    uint256 internal constant OUTSIDER_KEY = 0xBADBAD;
    bytes32 internal constant NEW_GUARDIAN_ROOT = keccak256("rotated-guardian-root");
    uint48 internal constant ANNOUNCEMENT_EXPIRY = 1 days;

    LoomAccount internal account;
    RecoveryManager internal recovery;
    RecoveryIntentBoard internal board;
    ECDSAGuardianVerifier internal guardianVerifier;
    MockValidator internal oldValidator;
    MockValidator internal secondValidator;
    MockValidator internal newValidator;

    bytes32 internal leafA;
    bytes32 internal leafB;
    bytes32 internal saltA = keccak256("guardian-a-salt");
    bytes32 internal saltB = keccak256("guardian-b-salt");
    bytes32 internal commitmentA;
    bytes32 internal commitmentB;
    bytes32 internal guardianRoot;
    // Ordering depends on the verifier's code hash, which changes with compiler
    // settings, so the signing key has to travel with the identity it belongs
    // to. Leaving the keys as constants silently pairs one guardian's
    // commitment with the other's signature whenever the sort flips.
    uint256 internal keyA = GUARDIAN_A_KEY;
    uint256 internal keyB = GUARDIAN_B_KEY;

    function setUp() public {
        recovery = new RecoveryManager();
        board = new RecoveryIntentBoard();
        guardianVerifier = new ECDSAGuardianVerifier();
        oldValidator = new MockValidator();
        secondValidator = new MockValidator();
        newValidator = new MockValidator();

        commitmentA = keccak256(abi.encode(vm.addr(GUARDIAN_A_KEY)));
        commitmentB = keccak256(abi.encode(vm.addr(GUARDIAN_B_KEY)));
        leafA = _leaf(commitmentA, saltA);
        leafB = _leaf(commitmentB, saltB);
        // The approval array must be strictly increasing by leaf, so order the
        // guardians once here and let every test rely on A < B.
        if (leafA > leafB) {
            (leafA, leafB) = (leafB, leafA);
            (commitmentA, commitmentB) = (commitmentB, commitmentA);
            (saltA, saltB) = (saltB, saltA);
            (keyA, keyB) = (keyB, keyA);
        }
        guardianRoot = _pairHash(leafA, leafB);

        address[] memory validators = _sortedValidators();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        account = new LoomAccount(address(this), guardianRoot, 2, keccak256("config"), modules);
    }

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

    // --- Helpers ------------------------------------------------------------

    function _leaf(bytes32 commitment, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, commitment, salt));
    }

    function _pairHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _digest(address[] memory validators, uint64 nonce, uint64 version) internal view returns (bytes32) {
        return recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(newValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            version,
            nonce
        );
    }

    function _approval(bytes32 sibling, address verifier, bytes32 commitment, bytes32 salt, uint256 key, bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval memory approval)
    {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        approval = GuardianVerificationLib.Approval({
            verifier: verifier,
            keyCommitment: commitment,
            salt: salt,
            signature: abi.encodePacked(r, s, v),
            proof: proof
        });
    }

    function _one(GuardianVerificationLib.Approval memory approval)
        internal
        pure
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = approval;
    }

    function _bundle(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        approvals = new GuardianVerificationLib.Approval[](2);
        approvals[0] = _approval(leafB, address(guardianVerifier), commitmentA, saltA, keyA, digest);
        approvals[1] = _approval(leafA, address(guardianVerifier), commitmentB, saltB, keyB, digest);
    }

    function _publish(GuardianVerificationLib.Approval memory approval) internal returns (bytes32) {
        return board.publishApproval(
            address(account),
            address(recovery),
            keccak256(abi.encode(_sortedValidators())),
            address(newValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            _one(approval)
        );
    }

    function _tryPublish(GuardianVerificationLib.Approval memory approval) internal returns (bool ok) {
        return _tryPublishMany(_one(approval));
    }

    function _tryPublishMany(GuardianVerificationLib.Approval[] memory approvals) internal returns (bool ok) {
        (ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(account),
                        address(recovery),
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

    function _announce(uint48 expiresAt) internal returns (bytes32) {
        return board.announce(
            address(account),
            address(recovery),
            keccak256(abi.encode(_sortedValidators())),
            address(newValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            expiresAt
        );
    }

    /// Any accepted self-configuration advances `configVersion`, which is what a
    /// stale approval must be rejected against. Module installation is
    /// `onlyScheduledSelf`, so this goes through the account's own timelock.
    function _advanceConfigVersion() internal {
        MockValidator extra = new MockValidator();
        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(extra), ""));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, install, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, install);
    }

    function _sortedValidators() internal view returns (address[] memory validators) {
        validators = new address[](2);
        validators[0] = address(oldValidator);
        validators[1] = address(secondValidator);
        if (validators[0] > validators[1]) (validators[0], validators[1]) = (validators[1], validators[0]);
    }

    function _pending() internal view returns (RecoveryManager.PendingRecovery memory pending) {
        (
            pending.oldValidatorsHash,
            pending.newValidator,
            pending.initDataHash,
            pending.newGuardianRoot,
            pending.newGuardianThreshold,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = recovery.pendingRecoveries(address(account));
    }
}
