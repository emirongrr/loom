// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
import {GuardianVerificationLib} from "../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../src/LoomAccount.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {ReentrantModule} from "./mocks/ReentrantModule.sol";

interface VmRecovery {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract RecoveryManagerTest {
    VmRecovery internal constant vm = VmRecovery(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    bytes32 internal constant NEW_GUARDIAN_ROOT = keccak256("rotated-guardian-root");

    LoomAccount internal account;
    RecoveryManager internal recovery;
    ECDSAGuardianVerifier internal guardianVerifier;
    MockValidator internal oldValidator;
    MockValidator internal secondValidator;
    MockValidator internal newValidator;
    address internal guardian;
    bytes32 internal keyCommitment;
    bytes32 internal guardianSalt;
    bytes32 internal guardianLeaf;

    function setUp() public {
        recovery = new RecoveryManager();
        guardianVerifier = new ECDSAGuardianVerifier();
        oldValidator = new MockValidator();
        secondValidator = new MockValidator();
        newValidator = new MockValidator();
        guardian = vm.addr(GUARDIAN_KEY);
        keyCommitment = keccak256(abi.encode(guardian));
        guardianSalt = keccak256("guardian-salt");
        guardianLeaf = keccak256(
            abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, guardianSalt)
        );

        address[] memory validators = _sortedValidators();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        account = new LoomAccount(address(this), guardianLeaf, 1, keccak256("config"), modules);
    }

    function testVisibleDelayedRecoveryReplacesEveryValidator() public {
        bytes memory initData = "";
        address[] memory oldValidators = _sortedValidators();
        bytes32 recoveryId = _propose(initData);
        (
            bytes32 storedOldHash,
            address storedNew,
            bytes32 initDataHash,
            bytes32 newGuardianRoot,
            uint8 newGuardianThreshold,
            uint48 readyAt,
            uint48 expiresAt,
            uint64 version,
            uint64 nonce
        ) = recovery.pendingRecoveries(address(account));
        require(storedOldHash == keccak256(abi.encode(oldValidators)), "validator set not visible");
        require(storedNew == address(newValidator) && initDataHash == keccak256(initData), "wrong recovery");
        require(newGuardianRoot == NEW_GUARDIAN_ROOT && newGuardianThreshold == 1, "guardian rotation not committed");
        // forge-lint: disable-next-line(block-timestamp)
        require(readyAt > block.timestamp && expiresAt > readyAt, "recovery timing missing");
        require(version == account.configVersion() && nonce == 0 && recoveryId != bytes32(0), "wrong snapshot");

        (bool early,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), oldValidators, initData)));
        require(!early, "recovery executed early");

        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators, initData);
        require(account.validatorCount() == 1, "compromised validators remained");
        require(account.validatorAt(0) == address(newValidator), "new validator missing");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, oldValidators[0]), "first validator remained");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, oldValidators[1]), "second validator remained");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not rotated");
        require(account.guardianThreshold() == 1, "guardian threshold not rotated");
        require(recovery.recoveryNonces(address(account)) == 1, "recovery nonce not advanced");
        require(account.configVersion() == version + 1, "config version not advanced once");
    }

    function testGuardianlessAccountCannotProposeRecovery() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(oldValidator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount unprotected = new LoomAccount(address(this), bytes32(0), 0, keccak256("bootstrap-config"), modules);

        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](0);
        (bool accepted,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(unprotected),
                        oldValidators,
                        address(newValidator),
                        keccak256(""),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
        require(!accepted, "guardianless recovery proposed");
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(unprotected));
        require(readyAt == 0, "guardianless recovery stored");
    }

    function testRecoveryRejectsPartialOrUnsortedValidatorSet() public {
        bytes memory initData = "";
        address[] memory subset = new address[](1);
        subset[0] = address(oldValidator);
        GuardianVerificationLib.Approval[] memory approvals = _proposalApprovals(subset, initData, 0, 1);
        (bool partialAccepted,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        subset,
                        address(newValidator),
                        keccak256(initData),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
        require(!partialAccepted, "partial validator recovery accepted");

        address[] memory unsorted = _sortedValidators();
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        approvals = _proposalApprovals(unsorted, initData, 0, 1);
        (bool unsortedAccepted,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        unsorted,
                        address(newValidator),
                        keccak256(initData),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
        require(!unsortedAccepted, "unsorted validator recovery accepted");
    }

    function testGuardianApprovalBindsSaltVerifierCodeAndKeyCommitment() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        GuardianVerificationLib.Approval[] memory approvals = _proposalApprovals(validators, initData, 0, 1);
        approvals[0].salt = keccak256("wrong-salt");
        (bool wrongSalt,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        validators,
                        address(newValidator),
                        keccak256(initData),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
        require(!wrongSalt, "uncommitted guardian salt accepted");

        approvals = _proposalApprovals(validators, initData, 0, 1);
        approvals[0].keyCommitment = keccak256("wrong-key");
        (bool wrongKey,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        validators,
                        address(newValidator),
                        keccak256(initData),
                        NEW_GUARDIAN_ROOT,
                        1,
                        approvals
                    )
                )
            );
        require(!wrongKey, "uncommitted guardian key accepted");
    }

    function testAccountAndGuardianCanCancelRecovery() public {
        bytes memory initData = "";
        _propose(initData);
        bytes memory cancel = abi.encodeCall(RecoveryManager.cancelRecovery, (address(account)));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, cancel)));
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "account cancellation failed");

        _propose(initData);
        RecoveryManager.PendingRecovery memory pending = _pending();
        bytes32 recoveryId = recovery.recoveryIdFor(address(account), pending);
        bytes32 digest = recovery.cancelDigest(address(account), recoveryId, pending.configVersion, pending.nonce);
        recovery.cancelRecoveryWithGuardians(address(account), _guardianApprovals(digest));
        (,,,,, readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "guardian cancellation failed");
    }

    function testFrozenAccountCanCancelExactRecovery() public {
        bytes memory initData = "";
        _propose(initData);
        uint256 freezeNonce = account.freezeNonces(guardianLeaf);
        bytes32 freezeStruct =
            keccak256(abi.encode(account.FREEZE_TYPEHASH(), guardianLeaf, freezeNonce, account.configVersion()));
        bytes32 domain = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(),
                keccak256("LoomAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 freezeDigest = keccak256(abi.encodePacked("\x19\x01", domain, freezeStruct));
        account.freeze(
            address(guardianVerifier), keyCommitment, guardianSalt, new bytes32[](0), _guardianSignature(freezeDigest)
        );

        bytes memory cancel = abi.encodeCall(RecoveryManager.cancelRecovery, (address(account)));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, cancel)));
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == 0, "frozen cancellation failed");
    }

    /// @dev Adversarial race: a compromised primary validator schedules a
    /// guardian-config rewrite whose config-version bump would invalidate the
    /// pending guardian recovery (both paths take 3 days, so without a defense
    /// the attacker wins by executing first - see
    /// testConfigChangeInvalidatesAndExpiryBlocksRecovery). A single guardian
    /// freeze covering the ready moment blocks executeScheduled but not
    /// recovery execution, so the guardians win the race, and the recovery's
    /// own config advance permanently invalidates the attacker's operation.
    function testGuardianFreezeProtectsRecoveryFromScheduledConfigBump() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();

        bytes memory bump = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("attacker-root"), uint8(1)));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, bump, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));

        _propose(initData);
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));

        // FREEZE_DURATION is 2 days, so freezing one day before readiness
        // covers the moment both operations become executable.
        vm.warp(readyAt - 1 days);
        _freeze();

        vm.warp(readyAt);
        (bool bumped,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, bump)));
        require(!bumped, "frozen account executed the scheduled config bump");

        recovery.executeRecovery(address(account), validators, initData);
        require(account.validatorCount() == 1, "recovery did not replace validators during freeze");
        require(account.validatorAt(0) == address(newValidator), "new validator missing after race");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not rotated during freeze");

        vm.warp(uint256(account.frozenUntil()) + 1);
        (bool late,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, bump)));
        require(!late, "stale scheduled config bump executed after recovery");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "attacker rotated guardians after recovery");
    }

    function testConfigChangeInvalidatesAndExpiryBlocksRecovery() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        _propose(initData);
        bytes memory guardianUpdate = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-root"), uint8(1)));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, guardianUpdate, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, guardianUpdate);
        (bool stale,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators, initData)));
        require(!stale, "stale config recovery executed");
    }

    function testOnlyInstalledRecoveryModuleCanReplaceValidators() public {
        address[] memory validators = _sortedValidators();
        (bool direct,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.recoverConfiguration,
                    (validators, address(newValidator), bytes(""), NEW_GUARDIAN_ROOT, uint8(1))
                )
            );
        require(!direct, "external caller recovered validators");

        RecoveryManager uninstalled = new RecoveryManager();
        (bool invalidProposal,) = address(uninstalled)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        validators,
                        address(newValidator),
                        keccak256(bytes("")),
                        NEW_GUARDIAN_ROOT,
                        uint8(1),
                        new GuardianVerificationLib.Approval[](0)
                    )
                )
            );
        require(!invalidProposal, "uninstalled recovery module proposed");
    }

    function testRecoveryReentrantValidatorInitializationRollsBack() public {
        ReentrantModule reentrantValidator = new ReentrantModule();
        address[] memory validators = _sortedValidators();
        bytes memory initData = abi.encodeCall(ReentrantModule.initialize, ());
        uint64 nonce = recovery.recoveryNonces(address(account));
        bytes32 digest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(reentrantValidator),
            keccak256(initData),
            NEW_GUARDIAN_ROOT,
            1,
            account.configVersion(),
            nonce
        );
        recovery.proposeRecovery(
            address(account),
            validators,
            address(reentrantValidator),
            keccak256(initData),
            NEW_GUARDIAN_ROOT,
            1,
            _guardianApprovals(digest)
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);

        (bool executed,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators, initData)));

        require(!executed, "reentrant recovery succeeded");
        require(account.validatorCount() == validators.length, "validator set changed");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, address(reentrantValidator)), "attacker installed");
        require(account.guardianRoot() == guardianLeaf, "failed recovery changed guardian root");
        (,,,,, readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt != 0, "failed recovery did not roll back");
    }

    function testRecoveryRequiresFreshValidGuardianConfiguration() public {
        address[] memory validators = _sortedValidators();
        bytes memory initData = "";
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovals(validators, initData, 0, account.configVersion());

        require(!_tryPropose(validators, initData, account.guardianRoot(), 1, approvals), "same guardian root accepted");
        require(!_tryPropose(validators, initData, bytes32(0), 1, approvals), "zero guardian root accepted");
        require(!_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, 0, approvals), "zero threshold accepted");
        require(
            !_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, recovery.MAX_GUARDIAN_THRESHOLD() + 1, approvals),
            "excessive threshold accepted"
        );
    }

    function testPendingRecoveryRejectsReplayWrongPayloadUnauthorizedCancelAndExpiry() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        _propose(initData);
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovals(validators, initData, 0, account.configVersion());
        require(!_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, 1, approvals), "second pending recovery accepted");

        (bool unauthorizedCancel,) =
            address(recovery).call(abi.encodeCall(RecoveryManager.cancelRecovery, (address(account))));
        require(!unauthorizedCancel, "external cancellation accepted");

        (bool wrongPayload,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators, bytes("wrong"))));
        require(!wrongPayload, "wrong recovery payload accepted");

        RecoveryManager.PendingRecovery memory pending = _pending();
        vm.warp(pending.expiresAt + 1);
        (bool expired,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators, initData)));
        require(!expired, "expired recovery executed");
    }

    function testGuardianApprovalRejectsMalformedAndInvalidSignature() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovals(validators, initData, 0, account.configVersion());

        approvals[0].keyCommitment = bytes32(0);
        require(!_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, 1, approvals), "zero commitment accepted");

        approvals = _proposalApprovals(validators, initData, 0, account.configVersion());
        approvals[0].proof = new bytes32[](GuardianVerificationLib.MAX_PROOF_LENGTH + 1);
        require(!_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, 1, approvals), "oversized proof accepted");

        approvals = _proposalApprovals(validators, initData, 0, account.configVersion());
        approvals[0].signature = hex"00";
        require(!_tryPropose(validators, initData, NEW_GUARDIAN_ROOT, 1, approvals), "invalid signature accepted");
    }

    function _propose(bytes memory initData) internal returns (bytes32) {
        address[] memory validators = _sortedValidators();
        uint64 nonce = recovery.recoveryNonces(address(account));
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovals(validators, initData, nonce, account.configVersion());
        return recovery.proposeRecovery(
            address(account), validators, address(newValidator), keccak256(initData), NEW_GUARDIAN_ROOT, 1, approvals
        );
    }

    function _proposalApprovals(address[] memory validators, bytes memory initData, uint64 nonce, uint64 version)
        internal
        returns (GuardianVerificationLib.Approval[] memory)
    {
        bytes32 digest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(newValidator),
            keccak256(initData),
            NEW_GUARDIAN_ROOT,
            1,
            version,
            nonce
        );
        return _guardianApprovals(digest);
    }

    function _guardianApprovals(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keyCommitment,
            salt: guardianSalt,
            signature: _guardianSignature(digest),
            proof: new bytes32[](0)
        });
    }

    function _freeze() internal {
        uint256 freezeNonce = account.freezeNonces(guardianLeaf);
        bytes32 freezeStruct =
            keccak256(abi.encode(account.FREEZE_TYPEHASH(), guardianLeaf, freezeNonce, account.configVersion()));
        bytes32 domain = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(),
                keccak256("LoomAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 freezeDigest = keccak256(abi.encodePacked("\x19\x01", domain, freezeStruct));
        account.freeze(
            address(guardianVerifier), keyCommitment, guardianSalt, new bytes32[](0), _guardianSignature(freezeDigest)
        );
    }

    function _guardianSignature(bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _tryPropose(
        address[] memory validators,
        bytes memory initData,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        GuardianVerificationLib.Approval[] memory approvals
    ) internal returns (bool ok) {
        (ok,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (
                        address(account),
                        validators,
                        address(newValidator),
                        keccak256(initData),
                        newGuardianRoot,
                        newGuardianThreshold,
                        approvals
                    )
                )
            );
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
