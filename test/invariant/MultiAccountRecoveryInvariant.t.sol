// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {StdInvariant} from "../../lib/openzeppelin-contracts/lib/forge-std/src/StdInvariant.sol";

interface VmMultiAccountRecoveryInvariant {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MultiAccountRecoveryHandler {
    VmMultiAccountRecoveryInvariant internal constant vm =
        VmMultiAccountRecoveryInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ALICE_GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant BOB_GUARDIAN_KEY = 0xB0B;
    bytes32 internal constant EMPTY_INIT_DATA_HASH = keccak256("");
    bytes32 internal constant CONFIGURATION_RECOVERED_HASH = keccak256("CONFIGURATION_RECOVERED");

    MockEntryPoint public immutable entryPoint;
    RecoveryManager public immutable recovery;
    ECDSAGuardianVerifier public immutable guardianVerifier;
    LoomAccount public immutable alice;
    LoomAccount public immutable bob;
    MockValidator public immutable aliceValidatorA;
    MockValidator public immutable aliceValidatorB;
    MockValidator public immutable bobValidatorA;
    MockValidator public immutable bobValidatorB;

    bytes32 public immutable aliceGuardianRootA;
    bytes32 public immutable aliceGuardianRootB;
    bytes32 public immutable bobGuardianRootA;
    bytes32 public immutable bobGuardianRootB;
    bytes32 public immutable aliceGuardianSaltA;
    bytes32 public immutable aliceGuardianSaltB;
    bytes32 public immutable bobGuardianSaltA;
    bytes32 public immutable bobGuardianSaltB;

    bool public violated;
    uint64 public lastAliceRecoveryNonce;
    uint64 public lastBobRecoveryNonce;
    uint256 public successfulProposals;
    uint256 public successfulCancellations;
    uint256 public successfulExecutions;
    uint256 public rejectedCrossAccountApprovals;

    struct AccountSnapshot {
        address validator;
        uint256 validatorCount;
        bytes32 guardianRoot;
        uint8 guardianThreshold;
        bytes32 configHash;
        uint64 configVersion;
        uint48 frozenUntil;
        uint64 recoveryNonce;
        RecoveryManager.PendingRecovery pending;
    }

    struct SystemSnapshot {
        AccountSnapshot aliceState;
        AccountSnapshot bobState;
    }

    constructor() {
        entryPoint = new MockEntryPoint();
        recovery = new RecoveryManager();
        guardianVerifier = new ECDSAGuardianVerifier();
        aliceValidatorA = new MockValidator();
        aliceValidatorB = new MockValidator();
        bobValidatorA = new MockValidator();
        bobValidatorB = new MockValidator();

        aliceGuardianSaltA = keccak256("multi-account-recovery-alice-a");
        aliceGuardianSaltB = keccak256("multi-account-recovery-alice-b");
        bobGuardianSaltA = keccak256("multi-account-recovery-bob-a");
        bobGuardianSaltB = keccak256("multi-account-recovery-bob-b");
        aliceGuardianRootA = _guardianLeaf(ALICE_GUARDIAN_KEY, aliceGuardianSaltA);
        aliceGuardianRootB = _guardianLeaf(ALICE_GUARDIAN_KEY, aliceGuardianSaltB);
        bobGuardianRootA = _guardianLeaf(BOB_GUARDIAN_KEY, bobGuardianSaltA);
        bobGuardianRootB = _guardianLeaf(BOB_GUARDIAN_KEY, bobGuardianSaltB);

        alice = new LoomAccount(
            address(entryPoint),
            aliceGuardianRootA,
            1,
            keccak256("multi-account-recovery-alice-config"),
            _modules(aliceValidatorA)
        );
        bob = new LoomAccount(
            address(entryPoint),
            bobGuardianRootA,
            1,
            keccak256("multi-account-recovery-bob-config"),
            _modules(bobValidatorA)
        );
    }

    function proposeAlice() external {
        _propose(alice, bob);
    }

    function proposeBob() external {
        _propose(bob, alice);
    }

    function cancelAliceWithGuardians() external {
        _cancelWithGuardians(alice, bob);
    }

    function cancelBobWithGuardians() external {
        _cancelWithGuardians(bob, alice);
    }

    function executeAliceRecovery() external {
        _execute(alice, bob);
    }

    function executeBobRecovery() external {
        _execute(bob, alice);
    }

    function rejectAliceProposalApprovalForBob() external {
        if (_pending(bob).readyAt != 0) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        address[] memory bobValidators = _currentValidators(bob);
        address nextBobValidator = _nextValidator(bob);
        bytes32 nextBobRoot = _nextGuardianRoot(bob);
        bytes32 digest = recovery.proposalDigest(
            address(alice),
            keccak256(abi.encode(bobValidators)),
            nextBobValidator,
            EMPTY_INIT_DATA_HASH,
            nextBobRoot,
            1,
            bob.configVersion(),
            recovery.recoveryNonces(address(bob))
        );
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(alice, digest);

        (bool ok, bytes memory revertData) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (address(bob), bobValidators, nextBobValidator, EMPTY_INIT_DATA_HASH, nextBobRoot, 1, approvals)
                )
            );
        if (ok || keccak256(revertData) != keccak256(abi.encodeWithSelector(RecoveryManager.InvalidRecovery.selector)))
        {
            violated = true;
        }
        if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
        if (!ok) ++rejectedCrossAccountApprovals;
        _observeNonces();
    }

    function rejectAliceCancellationApprovalForBob() external {
        if (_pending(alice).readyAt == 0 || _pending(bob).readyAt == 0) return;
        SystemSnapshot memory beforeState = _systemSnapshot();
        RecoveryManager.PendingRecovery memory alicePending = _pending(alice);
        bytes32 aliceRecoveryId = recovery.recoveryIdFor(address(alice), alicePending);
        bytes32 aliceDigest =
            recovery.cancelDigest(address(alice), aliceRecoveryId, alicePending.configVersion, alicePending.nonce);
        GuardianVerificationLib.Approval[] memory aliceApprovals = _guardianApprovals(alice, aliceDigest);

        (bool ok, bytes memory revertData) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.cancelRecoveryWithGuardians, (address(bob), aliceApprovals)));
        if (
            ok
                || keccak256(revertData)
                    != keccak256(abi.encodeWithSelector(RecoveryManager.UnauthorizedCancellation.selector))
        ) violated = true;
        if (!_sameSystemState(beforeState, _systemSnapshot())) violated = true;
        if (!ok) ++rejectedCrossAccountApprovals;
        _observeNonces();
    }

    function _propose(LoomAccount account, LoomAccount other) internal {
        if (_pending(account).readyAt != 0) return;
        AccountSnapshot memory otherBefore = _snapshot(other);
        AccountSnapshot memory accountBefore = _snapshot(account);
        address[] memory validators = _currentValidators(account);
        address nextValidator = _nextValidator(account);
        bytes32 nextRoot = _nextGuardianRoot(account);
        uint64 nonce = recovery.recoveryNonces(address(account));
        bytes32 digest = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(validators)),
            nextValidator,
            EMPTY_INIT_DATA_HASH,
            nextRoot,
            1,
            account.configVersion(),
            nonce
        );
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(account, digest);

        (bool ok,) = address(recovery)
            .call(
                abi.encodeCall(
                    RecoveryManager.proposeRecovery,
                    (address(account), validators, nextValidator, EMPTY_INIT_DATA_HASH, nextRoot, 1, approvals)
                )
            );
        RecoveryManager.PendingRecovery memory pending = _pending(account);
        if (!ok || pending.readyAt == 0) violated = true;
        AccountSnapshot memory accountAfter = _snapshot(account);
        if (!_sameLiveAuthority(accountBefore, accountAfter)) violated = true;
        if (accountAfter.recoveryNonce != accountBefore.recoveryNonce) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) ++successfulProposals;
        _observeNonces();
    }

    function _cancelWithGuardians(LoomAccount account, LoomAccount other) internal {
        RecoveryManager.PendingRecovery memory pending = _pending(account);
        if (pending.readyAt == 0) return;
        AccountSnapshot memory accountBefore = _snapshot(account);
        AccountSnapshot memory otherBefore = _snapshot(other);
        bytes32 recoveryId = recovery.recoveryIdFor(address(account), pending);
        bytes32 digest = recovery.cancelDigest(address(account), recoveryId, pending.configVersion, pending.nonce);
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(account, digest);

        (bool ok,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.cancelRecoveryWithGuardians, (address(account), approvals)));
        AccountSnapshot memory accountAfter = _snapshot(account);
        if (!ok || accountAfter.pending.readyAt != 0 || accountAfter.recoveryNonce != accountBefore.recoveryNonce + 1) {
            violated = true;
        }
        if (!_sameLiveAuthority(accountBefore, accountAfter)) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) ++successfulCancellations;
        _observeNonces();
    }

    function _execute(LoomAccount account, LoomAccount other) internal {
        RecoveryManager.PendingRecovery memory pending = _pending(account);
        if (pending.readyAt == 0) return;
        AccountSnapshot memory accountBefore = _snapshot(account);
        AccountSnapshot memory otherBefore = _snapshot(other);
        address[] memory validators = _currentValidators(account);
        vm.warp(pending.readyAt);

        (bool ok,) = address(recovery)
            .call(abi.encodeCall(RecoveryManager.executeRecovery, (address(account), validators, bytes(""))));
        AccountSnapshot memory accountAfter = _snapshot(account);
        if (!ok || accountAfter.pending.readyAt != 0) violated = true;
        if (accountAfter.validator != pending.newValidator || accountAfter.validatorCount != 1) violated = true;
        if (
            accountAfter.guardianRoot != pending.newGuardianRoot
                || accountAfter.guardianThreshold != pending.newGuardianThreshold
        ) violated = true;
        if (accountAfter.configVersion != accountBefore.configVersion + 1) violated = true;
        if (accountAfter.recoveryNonce != accountBefore.recoveryNonce + 1) violated = true;
        bytes32 changeHash = keccak256(
            abi.encode(
                CONFIGURATION_RECOVERED_HASH,
                keccak256(abi.encode(validators)),
                pending.newValidator,
                EMPTY_INIT_DATA_HASH,
                pending.newGuardianRoot,
                pending.newGuardianThreshold
            )
        );
        if (accountAfter.configHash != keccak256(abi.encode(accountBefore.configHash, changeHash))) violated = true;
        if (accountAfter.frozenUntil != accountBefore.frozenUntil) violated = true;
        if (!_sameAccountState(otherBefore, _snapshot(other))) violated = true;
        if (ok) ++successfulExecutions;
        _observeNonces();
    }

    function _guardianApprovals(LoomAccount account, bytes32 digest)
        internal
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        uint256 key = address(account) == address(alice) ? ALICE_GUARDIAN_KEY : BOB_GUARDIAN_KEY;
        bytes32 salt = _currentGuardianSalt(account);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keccak256(abi.encode(vm.addr(key))),
            salt: salt,
            signature: abi.encodePacked(r, s, v),
            proof: new bytes32[](0)
        });
    }

    function _modules(MockValidator validator) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
    }

    function _currentValidators(LoomAccount account) internal view returns (address[] memory validators) {
        validators = new address[](1);
        validators[0] = account.validatorAt(0);
    }

    function _nextValidator(LoomAccount account) internal view returns (address) {
        address current = account.validatorAt(0);
        if (address(account) == address(alice)) {
            return current == address(aliceValidatorA) ? address(aliceValidatorB) : address(aliceValidatorA);
        }
        return current == address(bobValidatorA) ? address(bobValidatorB) : address(bobValidatorA);
    }

    function _nextGuardianRoot(LoomAccount account) internal view returns (bytes32) {
        if (address(account) == address(alice)) {
            return account.guardianRoot() == aliceGuardianRootA ? aliceGuardianRootB : aliceGuardianRootA;
        }
        return account.guardianRoot() == bobGuardianRootA ? bobGuardianRootB : bobGuardianRootA;
    }

    function _currentGuardianSalt(LoomAccount account) internal view returns (bytes32) {
        if (address(account) == address(alice)) {
            return account.guardianRoot() == aliceGuardianRootA ? aliceGuardianSaltA : aliceGuardianSaltB;
        }
        return account.guardianRoot() == bobGuardianRootA ? bobGuardianSaltA : bobGuardianSaltB;
    }

    function _guardianLeaf(uint256 key, bytes32 salt) internal returns (bytes32) {
        return keccak256(
            abi.encode(
                address(guardianVerifier), address(guardianVerifier).codehash, keccak256(abi.encode(vm.addr(key))), salt
            )
        );
    }

    function _snapshot(LoomAccount account) internal view returns (AccountSnapshot memory state) {
        state = AccountSnapshot({
            validator: account.validatorAt(0),
            validatorCount: account.validatorCount(),
            guardianRoot: account.guardianRoot(),
            guardianThreshold: account.guardianThreshold(),
            configHash: account.configHash(),
            configVersion: account.configVersion(),
            frozenUntil: account.frozenUntil(),
            recoveryNonce: recovery.recoveryNonces(address(account)),
            pending: _pending(account)
        });
    }

    function _pending(LoomAccount account) internal view returns (RecoveryManager.PendingRecovery memory pending) {
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

    function _systemSnapshot() internal view returns (SystemSnapshot memory state) {
        state = SystemSnapshot({aliceState: _snapshot(alice), bobState: _snapshot(bob)});
    }

    function _sameLiveAuthority(AccountSnapshot memory left, AccountSnapshot memory right)
        internal
        pure
        returns (bool)
    {
        return left.validator == right.validator && left.validatorCount == right.validatorCount
            && left.guardianRoot == right.guardianRoot && left.guardianThreshold == right.guardianThreshold
            && left.configHash == right.configHash && left.configVersion == right.configVersion
            && left.frozenUntil == right.frozenUntil;
    }

    function _sameAccountState(AccountSnapshot memory left, AccountSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _sameSystemState(SystemSnapshot memory left, SystemSnapshot memory right) internal pure returns (bool) {
        return keccak256(abi.encode(left)) == keccak256(abi.encode(right));
    }

    function _observeNonces() internal {
        uint64 aliceNonce = recovery.recoveryNonces(address(alice));
        uint64 bobNonce = recovery.recoveryNonces(address(bob));
        if (aliceNonce < lastAliceRecoveryNonce || bobNonce < lastBobRecoveryNonce) violated = true;
        lastAliceRecoveryNonce = aliceNonce;
        lastBobRecoveryNonce = bobNonce;
    }
}

contract MultiAccountRecoveryInvariantTest is StdInvariant {
    MultiAccountRecoveryHandler internal handler;

    function setUp() public {
        handler = new MultiAccountRecoveryHandler();

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = MultiAccountRecoveryHandler.proposeAlice.selector;
        selectors[1] = MultiAccountRecoveryHandler.proposeBob.selector;
        selectors[2] = MultiAccountRecoveryHandler.cancelAliceWithGuardians.selector;
        selectors[3] = MultiAccountRecoveryHandler.cancelBobWithGuardians.selector;
        selectors[4] = MultiAccountRecoveryHandler.executeAliceRecovery.selector;
        selectors[5] = MultiAccountRecoveryHandler.executeBobRecovery.selector;
        selectors[6] = MultiAccountRecoveryHandler.rejectAliceProposalApprovalForBob.selector;
        selectors[7] = MultiAccountRecoveryHandler.rejectAliceCancellationApprovalForBob.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantRecoveryAuthorityRemainsAccountScoped() public view {
        LoomAccount alice = handler.alice();
        LoomAccount bob = handler.bob();
        require(!handler.violated(), "multi-account recovery handler observed an invariant violation");
        require(address(alice) != address(bob), "recovery account identities collided");
        require(alice.validatorCount() == 1 && bob.validatorCount() == 1, "recovery changed validator cardinality");
        require(
            alice.validatorAt(0) == address(handler.aliceValidatorA())
                || alice.validatorAt(0) == address(handler.aliceValidatorB()),
            "Alice validator escaped its recovery set"
        );
        require(
            bob.validatorAt(0) == address(handler.bobValidatorA())
                || bob.validatorAt(0) == address(handler.bobValidatorB()),
            "Bob validator escaped its recovery set"
        );
        require(
            alice.guardianRoot() == handler.aliceGuardianRootA()
                || alice.guardianRoot() == handler.aliceGuardianRootB(),
            "Alice guardian root escaped its recovery set"
        );
        require(
            bob.guardianRoot() == handler.bobGuardianRootA() || bob.guardianRoot() == handler.bobGuardianRootB(),
            "Bob guardian root escaped its recovery set"
        );
    }

    function invariantPendingRecoveriesRemainBoundToLiveAccounts() public view {
        _assertPendingBound(handler.alice());
        _assertPendingBound(handler.bob());
    }

    function invariantRecoveryNoncesNeverDecrease() public view {
        require(
            handler.recovery().recoveryNonces(address(handler.alice())) >= handler.lastAliceRecoveryNonce(),
            "Alice recovery nonce decreased"
        );
        require(
            handler.recovery().recoveryNonces(address(handler.bob())) >= handler.lastBobRecoveryNonce(),
            "Bob recovery nonce decreased"
        );
    }

    function _assertPendingBound(LoomAccount account) internal view {
        RecoveryManager.PendingRecovery memory pending = _pending(account);
        if (pending.readyAt == 0) return;
        address[] memory validators = new address[](1);
        validators[0] = account.validatorAt(0);
        require(pending.oldValidatorsHash == keccak256(abi.encode(validators)), "pending validator set drifted");
        require(pending.configVersion == account.configVersion(), "pending config version drifted");
        require(pending.nonce == handler.recovery().recoveryNonces(address(account)), "pending recovery nonce drifted");
        require(
            !account.isModuleInstalled(ModuleType.VALIDATOR, pending.newValidator),
            "pending validator is already installed"
        );
    }

    function _pending(LoomAccount account) internal view returns (RecoveryManager.PendingRecovery memory pending) {
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
        ) = handler.recovery().pendingRecoveries(address(account));
    }
}
