// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {MigrationModule} from "../../src/MigrationModule.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {ReentrantModule} from "../mocks/ReentrantModule.sol";
import {P256RecoveryValidatorFactory} from "../../src/validators/P256RecoveryValidatorFactory.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {P256TestKeys} from "../helpers/P256TestKeys.sol";

interface VmRecovery {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract RecoveryManagerTest {
    VmRecovery internal constant vm = VmRecovery(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant SECOND_GUARDIAN_KEY = 0xB0B;
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
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](4);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        modules[3] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(new MigrationModule()), "");
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

        (bool early,) =
            address(recovery).call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), oldValidators)));
        require(!early, "recovery executed early");

        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators);
        require(account.validatorCount() == 1, "compromised validators remained");
        require(account.validatorAt(0) == address(newValidator), "new validator missing");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, oldValidators[0]), "first validator remained");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, oldValidators[1]), "second validator remained");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not rotated");
        require(account.guardianThreshold() == 1, "guardian threshold not rotated");
        require(recovery.recoveryNonces(address(account)) == 1, "recovery nonce not advanced");
        require(account.configVersion() == version + 1, "config version not advanced once");
    }

    function testPermissionlessFactoryProvisionsTheNewPasskeyValidator() public {
        address policyHook = address(0xBEEF);
        bytes32 x = P256TestKeys.x(1);
        bytes32 y = P256TestKeys.y(1);
        bytes32 rpIdHash = keccak256("localhost");
        bytes32 originHash = keccak256("http://localhost:5174");
        bytes memory initData = abi.encodeCall(P256Validator.initialize, (x, y, rpIdHash, originHash, policyHook));
        P256RecoveryValidatorFactory provisioner = new P256RecoveryValidatorFactory(address(0));
        address provisioned =
            provisioner.deploy(address(account), 0, x, y, rpIdHash, originHash, policyHook, NEW_GUARDIAN_ROOT, 1);
        address[] memory oldValidators = _sortedValidators();
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovalsFor(provisioned, oldValidators, initData, 0, account.configVersion());

        recovery.proposeRecovery(
            address(account), oldValidators, provisioned, keccak256(initData), NEW_GUARDIAN_ROOT, 1, approvals
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators);

        require(account.validatorCount() == 1, "recovery did not replace validator set");
        require(account.validatorAt(0) == provisioned, "provisioned validator not installed");
        (bytes32 storedX, bytes32 storedY,,) = P256Validator(provisioned).publicKeys(address(account));
        require(storedX == x && storedY == y, "new passkey was not initialized");
    }

    function testProvisionedValidatorRejectsWrongEarlyInitializationAndRecoveryStillSucceeds() public {
        address policyHook = address(0xBEEF);
        bytes32 x = P256TestKeys.x(1);
        bytes32 y = P256TestKeys.y(1);
        bytes32 rpIdHash = keccak256("localhost");
        bytes32 originHash = keccak256("http://localhost:5174");
        bytes memory intendedInitData =
            abi.encodeCall(P256Validator.initialize, (x, y, rpIdHash, originHash, policyHook));
        P256RecoveryValidatorFactory provisioner = new P256RecoveryValidatorFactory(address(0));
        address provisioned =
            provisioner.deploy(address(account), 0, x, y, rpIdHash, originHash, policyHook, NEW_GUARDIAN_ROOT, 1);
        bytes memory wrongInitData = abi.encodeCall(
            P256Validator.initialize,
            (
                P256TestKeys.x(2),
                P256TestKeys.y(2),
                keccak256("wrong.example"),
                keccak256("https://wrong.example"),
                policyHook
            )
        );

        (bool poisoned,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(provisioned, 0, wrongInitData)))
                )
            );
        require(!poisoned, "wrong initializer consumed the reserved recovery validator");
        // The key was written when the validator was deployed (ADR-0025), so the
        // property is that a rejected initializer left it exactly as provisioned,
        // not that the validator is still empty.
        (bytes32 earlyX,,,) = P256Validator(provisioned).publicKeys(address(account));
        require(earlyX == x, "rejected initializer changed recovery validator state");

        address[] memory oldValidators = _sortedValidators();
        GuardianVerificationLib.Approval[] memory approvals =
            _proposalApprovalsFor(provisioned, oldValidators, intendedInitData, 0, account.configVersion());
        recovery.proposeRecovery(
            address(account), oldValidators, provisioned, keccak256(intendedInitData), NEW_GUARDIAN_ROOT, 1, approvals
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators);

        require(account.validatorAt(0) == provisioned, "reserved recovery validator was not installed");
        (bytes32 storedX, bytes32 storedY,,) = P256Validator(provisioned).publicKeys(address(account));
        require(storedX == P256TestKeys.x(1) && storedY == P256TestKeys.y(1), "wrong passkey survived recovery");
    }

    function testProvisionedValidatorRejectsScheduledKeyMutationBeforeInstallation() public {
        address policyHook = address(0xBEEF);
        bytes32 x = P256TestKeys.x(1);
        bytes32 y = P256TestKeys.y(1);
        bytes32 rpIdHash = keccak256("localhost");
        bytes32 originHash = keccak256("http://localhost:5174");
        P256RecoveryValidatorFactory provisioner = new P256RecoveryValidatorFactory(address(0));
        address provisioned =
            provisioner.deploy(address(account), 0, x, y, rpIdHash, originHash, policyHook, NEW_GUARDIAN_ROOT, 1);
        bytes memory mutate = abi.encodeCall(
            P256Validator.setKey,
            (P256TestKeys.x(2), P256TestKeys.y(2), keccak256("wrong.example"), keccak256("https://wrong.example"))
        );
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (provisioned, 0, mutate, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        uint64 versionBefore = account.configVersion();
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        (bool mutated,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (provisioned, 0, mutate)));

        require(!mutated, "uninstalled recovery validator accepted scheduled key mutation");
        require(account.configVersion() == versionBefore, "rejected mutation changed account configuration");
        (bytes32 storedX,,,) = P256Validator(provisioned).publicKeys(address(account));
        require(storedX == x, "rejected mutation changed the reserved passkey");
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
        bytes memory cancel = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), _accountCancellationApprovals())
        );
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

    /// @notice Possession of the current validator must not be enough to
    /// permanently grief a guardian recovery for that compromised validator.
    function testAccountCannotCancelRecoveryWithoutGuardianApproval() public {
        _propose("");

        GuardianVerificationLib.Approval[] memory noGuardianApprovals = new GuardianVerificationLib.Approval[](0);
        bytes memory cancel = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), noGuardianApprovals)
        );
        (bool cancelled,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, cancel)))
                )
            );

        require(!cancelled, "current validator cancelled recovery alone");
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt != 0, "failed cancellation cleared recovery");

        bytes memory legacyCancel = abi.encodeCall(RecoveryManager.cancelRecovery, (address(account)));
        (bool legacyCancelled,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, legacyCancel)))
                )
            );
        require(!legacyCancelled, "legacy owner-only selector cancelled recovery");
        (,,,,, readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt != 0, "legacy cancellation cleared recovery");
    }

    function testAccountCancellationRequiresOneLessThanRecoveryThreshold() public {
        address[] memory validators = _sortedValidators();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[0], "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validators[1], "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        LoomAccount thresholdAccount =
            new LoomAccount(address(this), _twoGuardianRoot(), 2, keccak256("threshold-config"), modules);

        bytes32 rotatedRoot = keccak256("threshold-rotated-root");
        bytes32 proposalDigest = recovery.proposalDigest(
            address(thresholdAccount),
            keccak256(abi.encode(validators)),
            address(newValidator),
            keccak256(bytes("")),
            rotatedRoot,
            1,
            thresholdAccount.configVersion(),
            0
        );
        recovery.proposeRecovery(
            address(thresholdAccount),
            validators,
            address(newValidator),
            keccak256(bytes("")),
            rotatedRoot,
            1,
            _twoGuardianApprovals(proposalDigest)
        );

        RecoveryManager.PendingRecovery memory pending;
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
        ) = recovery.pendingRecoveries(address(thresholdAccount));
        bytes32 recoveryId = recovery.recoveryIdFor(address(thresholdAccount), pending);
        bytes32 cancelDigest =
            recovery.cancelDigest(address(thresholdAccount), recoveryId, pending.configVersion, pending.nonce);

        GuardianVerificationLib.Approval[] memory none = new GuardianVerificationLib.Approval[](0);
        bytes memory unsupported =
            abi.encodeCall(RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(thresholdAccount), none));
        (bool ownerOnly,) = address(thresholdAccount)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, unsupported)))
                )
            );
        require(!ownerOnly, "2-of-2 recovery cancelled by owner alone");

        bytes memory supported = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians,
            (address(thresholdAccount), _oneOfTwoGuardianApprovals(cancelDigest))
        );
        thresholdAccount.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, supported)));
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(thresholdAccount));
        require(readyAt == 0, "owner plus threshold-minus-one guardian could not cancel");
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

        bytes memory cancel = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), _accountCancellationApprovals())
        );
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

        // Freezing one day before readiness covers the moment both operations
        // become executable.
        vm.warp(readyAt - 1 days);
        _freeze();

        vm.warp(readyAt);
        (bool bumped,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, bump)));
        require(!bumped, "frozen account executed the scheduled config bump");

        recovery.executeRecovery(address(account), validators);
        require(account.validatorCount() == 1, "recovery did not replace validators during freeze");
        require(account.validatorAt(0) == address(newValidator), "new validator missing after race");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "guardian root not rotated during freeze");

        vm.warp(uint256(account.frozenUntil()) + 1);
        (bool late,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, bump)));
        require(!late, "stale scheduled config bump executed after recovery");
        require(account.guardianRoot() == NEW_GUARDIAN_ROOT, "attacker rotated guardians after recovery");
    }

    /// @notice A freeze must cover the whole recovery path, not just its start.
    /// @dev The sibling test above schedules a configuration call, which carries the
    /// 3-day `MIN_CONFIG_DELAY` and therefore becomes ready at the same moment
    /// recovery does -- the one case a 2-day freeze happened to cover. External
    /// calls use the 1-day `MIN_EXTERNAL_DELAY`, so an attacker's operation is
    /// already ready when the guardian freezes. With a 2-day freeze the protection
    /// lapsed at T+2d while recovery only became executable at T+3d, leaving a
    /// roughly one-day window in which `executeScheduled` -- which is
    /// permissionless -- would have run the attacker's call.
    function testFreezeCoversRecoveryDelayForAlreadyReadyExternalOperation() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        MockTarget target = new MockTarget();
        bytes memory steal = abi.encodeCall(MockTarget.setValue, (42));

        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, steal, account.MIN_EXTERNAL_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));

        // The attacker's operation is ready before the guardians can react.
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());
        uint256 frozenAt = block.timestamp;
        _freeze();
        _propose(initData);
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        require(readyAt == frozenAt + recovery.RECOVERY_DELAY(), "unexpected recovery readiness");
        require(account.frozenUntil() >= readyAt, "freeze lapses before recovery is executable");

        (bool early,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, steal)));
        require(!early, "frozen account executed the attacker operation");

        // The moment the old two-day freeze would have lapsed, the account must
        // still be protected and the operation still blocked.
        vm.warp(frozenAt + 2 days + 1);
        // The timestamp comparison is the property under test, not an incidental
        // read: at the instant the old window would have expired, the freeze has
        // to still cover the account. The time is set by `vm.warp` here, so
        // there is no validator to manipulate it.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < account.frozenUntil(), "freeze lapsed before recovery could complete");
        (bool inOldGap,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, steal)));
        require(!inOldGap, "attacker executed in the old freeze gap");
        require(target.value() == 0, "attacker operation moved state");

        // Recovery becomes executable while the freeze still holds, and its own
        // configuration advance retires the attacker's operation for good.
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), validators);
        require(account.validatorAt(0) == address(newValidator), "recovery did not replace the validator set");

        vm.warp(uint256(account.frozenUntil()) + 1);
        (bool late,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, steal)));
        require(!late, "stale attacker operation executed after recovery");
        require(target.value() == 0, "attacker operation executed after recovery");
    }

    /// @notice Cancelling a recovery while frozen must retire stale authority
    /// and re-arm guardian intervention.
    /// @dev `_isFrozenSafe` deliberately allows exactly one action while frozen:
    /// cancelling this account's pending recovery with supporting guardian
    /// approvals. Because `freeze` allows each guardian leaf one freeze per
    /// configuration version, cancellation must advance the configuration rather
    /// than leave pre-scheduled authority alive through the next recovery window.
    ///
    /// The cancellation now advances the account configuration, which both retires
    /// that pending operation and re-arms every guardian leaf.
    function testFrozenRecoveryCancellationRetiresScheduleAndRearmsGuardians() public {
        bytes memory initData = "";
        MockTarget target = new MockTarget();
        bytes memory steal = abi.encodeCall(MockTarget.setValue, (42));

        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, steal, account.MIN_EXTERNAL_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());

        _freeze();
        _propose(initData);
        uint64 versionBeforeCancel = account.configVersion();
        uint48 frozenUntilBeforeCancel = account.frozenUntil();

        // The current account authority and a guardian cancel the recovery from
        // inside the freeze. The account cannot reach this path alone.
        bytes memory cancel = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), _accountCancellationApprovals())
        );
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, cancel)));

        (,,,,, uint48 readyAtAfterCancel,,,) = recovery.pendingRecoveries(address(account));
        require(readyAtAfterCancel == 0, "recovery was not cancelled");
        require(account.configVersion() == versionBeforeCancel + 1, "frozen cancellation did not advance config");
        require(account.frozenUntil() == frozenUntilBeforeCancel, "cancellation changed the freeze window");

        // The attacker's already-ready operation died with the configuration bump.
        (bool stale,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, steal)));
        require(!stale, "attacker operation survived the frozen cancellation");
        require(target.value() == 0, "attacker operation executed");

        // The same guardian leaf can freeze again, so cancelling bought no ground.
        // `freeze` only ever extends the window, so let time pass first to make the
        // extension observable rather than a no-op in the same block.
        uint256 freezeNonceBefore = account.freezeNonces(guardianLeaf);
        vm.warp(block.timestamp + 1 days);
        _freeze();
        require(account.freezeNonces(guardianLeaf) == freezeNonceBefore + 1, "guardian leaf could not freeze again");
        require(account.frozenUntil() > frozenUntilBeforeCancel, "re-freeze did not extend the window");

        // And recovery can be proposed and completed on the new configuration.
        _propose(initData);
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), _sortedValidators());
        require(account.validatorAt(0) == address(newValidator), "recovery did not complete after cancellation");
    }

    /// @notice An unfrozen recovery cancellation stays an ordinary action.
    /// @dev The configuration advance is scoped to the frozen path. Cancelling an
    /// uncontested recovery must not silently discard the owner's pending
    /// operations.
    function testUnfrozenRecoveryCancellationDoesNotAdvanceConfig() public {
        MockTarget target = new MockTarget();
        bytes memory pending = abi.encodeCall(MockTarget.setValue, (7));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, pending, account.MIN_EXTERNAL_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));

        _propose("");
        uint64 versionBefore = account.configVersion();

        bytes memory cancel = abi.encodeCall(
            RecoveryManager.cancelRecoveryWithAccountAndGuardians, (address(account), _accountCancellationApprovals())
        );
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(recovery), 0, cancel)));

        (,,,,, uint48 readyAtAfterCancel,,,) = recovery.pendingRecoveries(address(account));
        require(readyAtAfterCancel == 0, "recovery was not cancelled");
        require(account.configVersion() == versionBefore, "unfrozen cancellation advanced config");

        // The owner's unrelated scheduled operation survives and still executes.
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());
        account.executeScheduled(address(target), 0, pending);
        require(target.value() == 7, "owner operation was discarded by an unfrozen cancellation");
    }

    function testCompositeFreezeRecoveryAndMigrationState() public {
        bytes memory initData = "";
        address[] memory validators = _sortedValidators();
        MockTarget target = new MockTarget();

        LoomAccount.ModuleInit[] memory destinationModules = new LoomAccount.ModuleInit[](1);
        destinationModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(new MockValidator()), "");
        LoomAccount destination =
            new LoomAccount(address(this), guardianLeaf, 1, keccak256("destination-config"), destinationModules);

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (9)));
        bytes memory scheduleMigration = abi.encodeCall(
            MigrationModule.scheduleMigration,
            (
                address(destination),
                address(destination).codehash,
                destination.configHash(),
                keccak256(abi.encode(calls)),
                account.MIN_CONFIG_DELAY(),
                1 days
            )
        );
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(account.migrationModule(), 0, scheduleMigration)));
        _propose(initData);

        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt - 1 days);
        _freeze();
        vm.warp(readyAt);

        (bool migratedWhileFrozen,) = address(account).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!migratedWhileFrozen, "frozen account executed pending migration");
        require(target.value() == 0, "migration mutated target during freeze");

        recovery.executeRecovery(address(account), validators);
        require(account.validatorCount() == 1, "recovery did not replace validators in composite state");
        require(account.validatorAt(0) == address(newValidator), "new validator missing in composite state");

        vm.warp(uint256(account.frozenUntil()) + 1);
        (bool staleMigration,) = address(account).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!staleMigration, "stale migration survived recovery config change");
        require(target.value() == 0, "stale migration executed calls");
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
        (bool stale,) =
            address(recovery).call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators)));
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

    /// Recovery used to forward an initializer to the new validator, which gave
    /// that validator a call back into the account mid-installation. It no
    /// longer calls the new validator at all (ADR-0025), so a module that would
    /// re-enter never gets the opportunity; `isModuleType` is a `view`, so it
    /// cannot change state either.
    function testRecoveryNeverCallsIntoTheNewValidator() public {
        ReentrantModule reentrantValidator = new ReentrantModule();
        address[] memory validators = _sortedValidators();
        uint64 nonce = recovery.recoveryNonces(address(account));
        bytes32 digest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            address(reentrantValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            account.configVersion(),
            nonce
        );
        recovery.proposeRecovery(
            address(account),
            validators,
            address(reentrantValidator),
            keccak256(""),
            NEW_GUARDIAN_ROOT,
            1,
            _guardianApprovals(digest)
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);

        // `ReentrantModule.initialize` re-enters `execute`, which would revert
        // under the account's reentrancy guard. Recovery completing is the proof
        // that it was never invoked.
        recovery.executeRecovery(address(account), validators);

        require(account.validatorCount() == 1, "recovery did not replace the validator set");
        require(account.validatorAt(0) == address(reentrantValidator), "the proposed validator was not installed");
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

        (bool unauthorizedCancel,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.cancelRecoveryWithAccountAndGuardians,
                    (address(account), _accountCancellationApprovals())
                )
            );
        require(!unauthorizedCancel, "external cancellation accepted");

        (bool wrongPayload,) =
            address(recovery).call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators)));
        require(!wrongPayload, "wrong recovery payload accepted");

        RecoveryManager.PendingRecovery memory pending = _pending();
        vm.warp(pending.expiresAt + 1);
        (bool expired,) =
            address(recovery).call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators)));
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
        return _proposalApprovalsFor(address(newValidator), validators, initData, nonce, version);
    }

    function _proposalApprovalsFor(
        address targetValidator,
        address[] memory validators,
        bytes memory initData,
        uint64 nonce,
        uint64 version
    ) internal returns (GuardianVerificationLib.Approval[] memory) {
        bytes32 digest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            targetValidator,
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

    function _accountCancellationApprovals() internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        RecoveryManager.PendingRecovery memory pending = _pending();
        bytes32 recoveryId = recovery.recoveryIdFor(address(account), pending);
        bytes32 digest = recovery.cancelDigest(address(account), recoveryId, pending.configVersion, pending.nonce);
        return _guardianApprovals(digest);
    }

    function _twoGuardianRoot() internal returns (bytes32) {
        bytes32 first = guardianLeaf;
        bytes32 second = _secondGuardianLeaf();
        return first <= second ? keccak256(abi.encodePacked(first, second)) : keccak256(abi.encodePacked(second, first));
    }

    function _twoGuardianApprovals(bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        bytes32 first = guardianLeaf;
        bytes32 second = _secondGuardianLeaf();
        approvals = new GuardianVerificationLib.Approval[](2);
        if (first <= second) {
            approvals[0] = _guardianApproval(GUARDIAN_KEY, guardianSalt, second, digest);
            approvals[1] = _guardianApproval(SECOND_GUARDIAN_KEY, keccak256("second-guardian-salt"), first, digest);
        } else {
            approvals[0] = _guardianApproval(SECOND_GUARDIAN_KEY, keccak256("second-guardian-salt"), first, digest);
            approvals[1] = _guardianApproval(GUARDIAN_KEY, guardianSalt, second, digest);
        }
    }

    function _oneOfTwoGuardianApprovals(bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        bytes32 first = guardianLeaf;
        bytes32 second = _secondGuardianLeaf();
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = first <= second
            ? _guardianApproval(GUARDIAN_KEY, guardianSalt, second, digest)
            : _guardianApproval(SECOND_GUARDIAN_KEY, keccak256("second-guardian-salt"), first, digest);
    }

    function _secondGuardianLeaf() internal returns (bytes32) {
        address secondGuardian = vm.addr(SECOND_GUARDIAN_KEY);
        return keccak256(
            abi.encode(
                address(guardianVerifier),
                address(guardianVerifier).codehash,
                keccak256(abi.encode(secondGuardian)),
                keccak256("second-guardian-salt")
            )
        );
    }

    function _guardianApproval(uint256 privateKey, bytes32 salt, bytes32 sibling, bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval memory approval)
    {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keccak256(abi.encode(vm.addr(privateKey))),
            salt: salt,
            signature: _guardianSignature(privateKey, digest),
            proof: proof
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
        return _guardianSignature(GUARDIAN_KEY, digest);
    }

    function _guardianSignature(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
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
