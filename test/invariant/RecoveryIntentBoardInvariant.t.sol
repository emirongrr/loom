// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {RecoveryIntentBoard} from "../../src/recovery/RecoveryIntentBoard.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmBoardInvariant {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function load(address target, bytes32 slot) external view returns (bytes32);
}

/// @notice Drives arbitrary interleavings of board activity across two accounts.
///
/// The handler deliberately never proposes, cancels, or executes a recovery. Its
/// only powers are the two the board offers, so anything the invariants observe
/// moving is something the board moved — which is the whole question ADR-0024
/// leaves open once approvals can accumulate across transactions.
contract RecoveryIntentBoardHandler {
    VmBoardInvariant internal constant vm = VmBoardInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant BOB_GUARDIAN_KEY = 0xB0B;
    uint256 internal constant OUTSIDER_KEY = 0xBADBAD;
    bytes32 internal constant NEW_ROOT = keccak256("rotated-guardian-root");

    MockEntryPoint public immutable entryPoint;
    RecoveryManager public immutable recovery;
    RecoveryIntentBoard public immutable board;
    ECDSAGuardianVerifier public immutable guardianVerifier;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    MockValidator public immutable validatorA;
    MockValidator public immutable validatorB;
    MockValidator public immutable replacement;

    bytes32 public immutable aliceLeaf;
    bytes32 public immutable bobLeaf;
    bytes32 public immutable aliceCommitment;
    bytes32 public immutable bobCommitment;
    bytes32 public constant ALICE_SALT = keccak256("alice-guardian-salt");
    bytes32 public constant BOB_SALT = keccak256("bob-guardian-salt");

    uint256 public announcements;
    uint256 public publishedApprovals;
    uint256 public rejectedForgeries;
    uint256 public rejectedCrossAccountPublications;
    bool public violated;

    constructor() {
        entryPoint = new MockEntryPoint();
        recovery = new RecoveryManager();
        board = new RecoveryIntentBoard();
        guardianVerifier = new ECDSAGuardianVerifier();
        validatorA = new MockValidator();
        validatorB = new MockValidator();
        replacement = new MockValidator();

        aliceCommitment = keccak256(abi.encode(vm.addr(ALICE_GUARDIAN_KEY)));
        bobCommitment = keccak256(abi.encode(vm.addr(BOB_GUARDIAN_KEY)));
        aliceLeaf = _leaf(aliceCommitment, ALICE_SALT);
        bobLeaf = _leaf(bobCommitment, BOB_SALT);

        // Each account has a two-leaf tree so a single published approval is
        // genuinely below its own threshold.
        alice = _account(_pairHash(aliceLeaf, bobLeaf));
        bob = _account(_pairHash(bobLeaf, aliceLeaf));
    }

    // --- Actions --------------------------------------------------------------

    function announceForAlice(address newValidator, bytes32 oldHash, bytes32 initHash, uint8 seed, uint48 expiresAt)
        external
    {
        _announce(alice, newValidator, oldHash, initHash, seed, expiresAt);
    }

    function announceForBob(address newValidator, bytes32 oldHash, bytes32 initHash, uint8 seed, uint48 expiresAt)
        external
    {
        _announce(bob, newValidator, oldHash, initHash, seed, expiresAt);
    }

    function publishAliceApproval() external {
        if (_publish(alice, aliceCommitment, ALICE_SALT, bobLeaf, ALICE_GUARDIAN_KEY)) publishedApprovals += 1;
    }

    function publishBobApproval() external {
        if (_publish(bob, bobCommitment, BOB_SALT, aliceLeaf, BOB_GUARDIAN_KEY)) publishedApprovals += 1;
    }

    /// A signature from a key that is in no tree must never be publishable.
    function publishForgedApproval() external {
        if (_publish(alice, keccak256(abi.encode(vm.addr(OUTSIDER_KEY))), ALICE_SALT, bobLeaf, OUTSIDER_KEY)) {
            violated = true;
        } else {
            rejectedForgeries += 1;
        }
    }

    /// Alice's guardian is in Bob's tree too, but the digest binds the account,
    /// so a signature made for Alice must not publish against Bob.
    function publishAliceApprovalAgainstBob() external {
        bytes32 aliceDigest = _digest(alice);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: aliceCommitment,
            salt: ALICE_SALT,
            signature: _sign(ALICE_GUARDIAN_KEY, aliceDigest),
            proof: proof
        });
        if (_call(bob, approvals)) violated = true;
        else rejectedCrossAccountPublications += 1;
    }

    // --- Internals ------------------------------------------------------------

    function _announce(
        LoomAccount account,
        address newValidator,
        bytes32 oldHash,
        bytes32 initHash,
        uint8 seed,
        uint48 expiresAt
    ) internal {
        board.announce(
            address(account),
            address(recovery),
            oldHash,
            newValidator,
            initHash,
            NEW_ROOT,
            uint8(seed % 32) + 1,
            expiresAt
        );
        announcements += 1;
    }

    function _publish(LoomAccount account, bytes32 commitment, bytes32 salt, bytes32 sibling, uint256 key)
        internal
        returns (bool)
    {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: commitment,
            salt: salt,
            signature: _sign(key, _digest(account)),
            proof: proof
        });
        return _call(account, approvals);
    }

    function _call(LoomAccount account, GuardianVerificationLib.Approval[] memory approvals)
        internal
        returns (bool ok)
    {
        (ok,) = address(board)
            .call(
                abi.encodeCall(
                    RecoveryIntentBoard.publishApproval,
                    (
                        address(account),
                        address(recovery),
                        keccak256(abi.encode(_validators())),
                        address(replacement),
                        keccak256(""),
                        NEW_ROOT,
                        1,
                        approvals
                    )
                )
            );
    }

    function _digest(LoomAccount account) internal view returns (bytes32) {
        return recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(_validators())),
            address(replacement),
            keccak256(""),
            NEW_ROOT,
            1,
            account.configVersion(),
            recovery.recoveryNonces(address(account))
        );
    }

    function _sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _account(bytes32 root) internal returns (LoomAccount) {
        address[] memory validators = _validators();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        return new LoomAccount(address(entryPoint), root, 2, keccak256("config"), modules);
    }

    function _validators() internal view returns (address[] memory validators) {
        validators = new address[](2);
        validators[0] = address(validatorA);
        validators[1] = address(validatorB);
        if (validators[0] > validators[1]) (validators[0], validators[1]) = (validators[1], validators[0]);
    }

    function _leaf(bytes32 commitment, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, commitment, salt));
    }

    function _pairHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}

contract RecoveryIntentBoardInvariantTest is StdInvariant {
    VmBoardInvariant internal constant vm = VmBoardInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    RecoveryIntentBoardHandler internal handler;

    function setUp() public {
        handler = new RecoveryIntentBoardHandler();

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = RecoveryIntentBoardHandler.announceForAlice.selector;
        selectors[1] = RecoveryIntentBoardHandler.announceForBob.selector;
        selectors[2] = RecoveryIntentBoardHandler.publishAliceApproval.selector;
        selectors[3] = RecoveryIntentBoardHandler.publishBobApproval.selector;
        selectors[4] = RecoveryIntentBoardHandler.publishForgedApproval.selector;
        selectors[5] = RecoveryIntentBoardHandler.publishAliceApprovalAgainstBob.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The claim the whole design rests on: publishing accumulates evidence and
    /// nothing else. No sequence of announcements and approvals, across either
    /// account, may produce a pending recovery — only `proposeRecovery` can, and
    /// the handler cannot reach it.
    function invariantBoardActivityNeverCreatesAPendingRecovery() public view {
        require(!handler.violated(), "the board accepted an approval it should have refused");
        require(_readyAt(handler.alice()) == 0, "board activity created a pending recovery for alice");
        require(_readyAt(handler.bob()) == 0, "board activity created a pending recovery for bob");
    }

    /// Replay protection lives in the recovery nonce. Nothing the board does may
    /// advance it, or a published approval could invalidate a live request.
    function invariantBoardActivityNeverAdvancesRecoveryNonces() public view {
        require(handler.recovery().recoveryNonces(address(handler.alice())) == 0, "alice recovery nonce advanced");
        require(handler.recovery().recoveryNonces(address(handler.bob())) == 0, "bob recovery nonce advanced");
    }

    /// Guardian authority and configuration identity must be untouched, so a
    /// published approval can never rotate a set or invalidate a capability.
    function invariantBoardActivityNeverTouchesAccountConfiguration() public view {
        LoomAccount alice = handler.alice();
        LoomAccount bob = handler.bob();
        require(alice.guardianRoot() != bytes32(0) && bob.guardianRoot() != bytes32(0), "an account lost its root");
        require(alice.guardianRoot() != NEW_ROOT_SENTINEL, "alice guardian root rotated");
        require(bob.guardianRoot() != NEW_ROOT_SENTINEL, "bob guardian root rotated");
        require(alice.configVersion() == 1 && bob.configVersion() == 1, "configuration version advanced");
        require(alice.validatorCount() == 2 && bob.validatorCount() == 2, "the validator set changed");
    }

    /// ADR-0024 accepts a permissionless, unauthenticated `announce` only because
    /// the contract has no storage for a griefer to grow. Hold that across every
    /// interleaving, not just at deployment.
    function invariantBoardHoldsNoStorage() public view {
        for (uint256 slot; slot < 8; ++slot) {
            require(vm.load(address(handler.board()), bytes32(slot)) == bytes32(0), "the board wrote storage");
        }
    }

    /// The invariants above would hold trivially against a handler whose actions
    /// all silently failed. Drive each action once, deterministically, and assert
    /// the board was genuinely exercised in both directions. Kept out of
    ///  because a short random run need not touch every selector.
    function testHandlerReachesBothOutcomes() public {
        handler.announceForAlice(address(handler.replacement()), keccak256("old"), keccak256(""), 1, 1 days);
        handler.publishAliceApproval();
        handler.publishBobApproval();
        handler.publishForgedApproval();
        handler.publishAliceApprovalAgainstBob();

        require(handler.announcements() == 1, "the announcement did not land");
        require(handler.publishedApprovals() == 2, "a genuine guardian approval was refused");
        require(handler.rejectedForgeries() == 1, "a forged approval was not refused");
        require(handler.rejectedCrossAccountPublications() == 1, "a cross-account approval was not refused");
        require(!handler.violated(), "the handler observed the board accepting something it should refuse");
    }

    bytes32 internal constant NEW_ROOT_SENTINEL = keccak256("rotated-guardian-root");

    function _readyAt(LoomAccount account) internal view returns (uint48 readyAt) {
        (,,,,, readyAt,,,) = handler.recovery().pendingRecoveries(address(account));
    }
}
