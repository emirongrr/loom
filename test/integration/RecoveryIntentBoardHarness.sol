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
    function record() external;
    function accesses(address target) external returns (bytes32[] memory reads, bytes32[] memory writes);
}

/// @notice `RecoveryIntentBoard` must let guardian approvals accumulate across
/// separate transactions without becoming an authority. Every test here asserts
/// one of two things: that an approval published on the board is exactly what
/// `RecoveryManager` will independently accept, or that the board cannot reach
/// @notice Shared fixture for the `RecoveryIntentBoard` suites: one account with
/// two guardians, a real `RecoveryManager`, and the board.
///
/// This lives apart from the tests because the guardian ordering below is
/// subtle -- leaves are ordered by a hash that moves with compiler settings, so
/// the signing key has to travel with the identity. Duplicating that into a
/// second suite is how the pairing silently breaks, so both suites share it.
abstract contract RecoveryIntentBoardHarness {
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
