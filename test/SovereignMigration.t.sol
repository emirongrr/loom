// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

interface VmMigration {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract SovereignMigrationTest {
    VmMigration internal constant vm = VmMigration(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant SECOND_GUARDIAN_KEY = 0xB0B;
    ECDSAGuardianVerifier internal guardianVerifier = new ECDSAGuardianVerifier();

    function testMigrationIsDelayedPermissionlessAndDestinationBound() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 70)));
        calls[1] = ExecutionLib.Execution(address(destination), 1 ether, bytes(""));
        payable(address(source)).transfer(1 ether);

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        (address pendingDestination,,, bytes32 callsHash, uint48 readyAt,,,) = source.pendingMigration();
        require(pendingDestination == address(destination), "destination not committed");
        require(callsHash == keccak256(abi.encode(calls)), "calls hash not committed");

        (bool early,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!early, "migration executed before delay");

        vm.warp(readyAt);
        source.executeMigration(calls);

        require(token.balanceOf(address(destination)) == 70, "token migration failed");
        require(address(destination).balance == 1 ether, "eth migration failed");
        require(source.migrationNonce() == 1, "migration nonce did not advance");
        (,,, bytes32 clearedHash,,,,) = source.pendingMigration();
        require(clearedHash == bytes32(0), "pending migration not cleared");
    }

    function testMigrationCanTargetDifferentEntryPointAccount() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _accountWithEntryPoint(address(new MockEntryPoint()));
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);
        require(destination.entryPoint() != source.entryPoint(), "destination did not use another EntryPoint");

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 25)));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeMigration(calls);

        require(token.balanceOf(address(destination)) == 25, "different EntryPoint migration failed");
    }

    function testMigrationCanTargetCodehashOnlyFutureAccount() public {
        LoomAccount source = _account(false);
        FutureNativeAccountLike destination = new FutureNativeAccountLike();
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);
        payable(address(source)).transfer(1 ether);

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 15)));
        calls[1] = ExecutionLib.Execution(address(destination), 1 ether, bytes(""));
        _scheduleMigrationTo(
            source,
            address(destination),
            address(destination).codehash,
            bytes32(0),
            calls,
            source.MIN_CONFIG_DELAY(),
            1 days
        );
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeMigration(calls);

        require(token.balanceOf(address(destination)) == 15, "future account token migration failed");
        require(address(destination).balance == 1 ether, "future account eth migration failed");
    }

    function testMigrationRejectsUndeployedAndWrongCodehashDestination() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));

        address undeployed = address(0xBEEF);
        (bool acceptedUndeployed,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(source),
                                0,
                                abi.encodeCall(
                                    LoomAccount.scheduleMigration,
                                    (
                                        undeployed,
                                        keccak256("fake-codehash"),
                                        bytes32(0),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        1 days
                                    )
                                )
                            )
                        )
                    )
                )
            );
        require(!acceptedUndeployed, "undeployed migration destination accepted");

        (bool acceptedWrongCodehash,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(source),
                                0,
                                abi.encodeCall(
                                    LoomAccount.scheduleMigration,
                                    (
                                        address(destination),
                                        keccak256("wrong-codehash"),
                                        destination.configHash(),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        1 days
                                    )
                                )
                            )
                        )
                    )
                )
            );
        require(!acceptedWrongCodehash, "wrong destination codehash accepted");
    }

    function testMigrationRejectsWrongDestinationConfigAtScheduleAndInvalidWindow() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));

        (bool acceptedWrongConfig,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(source),
                                0,
                                abi.encodeCall(
                                    LoomAccount.scheduleMigration,
                                    (
                                        address(destination),
                                        address(destination).codehash,
                                        keccak256("wrong-destination-config"),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        1 days
                                    )
                                )
                            )
                        )
                    )
                )
            );
        require(!acceptedWrongConfig, "wrong destination config scheduled");

        (bool acceptedLongWindow,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(source),
                                0,
                                abi.encodeCall(
                                    LoomAccount.scheduleMigration,
                                    (
                                        address(destination),
                                        address(destination).codehash,
                                        destination.configHash(),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        source.MAX_MIGRATION_WINDOW() + 1
                                    )
                                )
                            )
                        )
                    )
                )
            );
        require(!acceptedLongWindow, "overlong migration window accepted");

        FutureNativeAccountLike futureDestination = new FutureNativeAccountLike();
        (bool acceptedOpaqueConfig,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(source),
                                0,
                                abi.encodeCall(
                                    LoomAccount.scheduleMigration,
                                    (
                                        address(futureDestination),
                                        address(futureDestination).codehash,
                                        keccak256("opaque-config"),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        1 days
                                    )
                                )
                            )
                        )
                    )
                )
            );
        require(!acceptedOpaqueConfig, "opaque destination accepted non-zero config");
    }

    function testMigrationRejectsWrongCallsDestinationConfigExpiryAndStaleConfig() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);

        ExecutionLib.Execution[] memory wrongCalls = new ExecutionLib.Execution[](1);
        wrongCalls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (2)));
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool wrongCallAccepted,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (wrongCalls)));
        require(!wrongCallAccepted, "wrong migration calls accepted");

        bytes memory guardianUpdate =
            abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-destination-root"), uint8(1)));
        _schedule(destination, address(destination), guardianUpdate, destination.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + destination.MIN_CONFIG_DELAY());
        destination.executeScheduled(address(destination), 0, guardianUpdate);
        (bool wrongConfigAccepted,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!wrongConfigAccepted, "wrong destination config accepted");

        source = _account(false);
        destination = _account(false);
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY() + 2);
        (bool expiredAccepted,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!expiredAccepted, "expired migration accepted");

        source = _account(false);
        destination = _account(false);
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        bytes memory sourceUpdate =
            abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-source-root"), uint8(1)));
        _schedule(source, address(source), sourceUpdate, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeScheduled(address(source), 0, sourceUpdate);
        (bool staleAccepted,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!staleAccepted, "stale config migration accepted");
    }

    function testMigrationSelfCancelIsBlockedWhileFrozen() public {
        LoomAccount source = _account(true);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        _freeze(source);
        (bool executedWhileFrozen,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!executedWhileFrozen, "frozen account executed migration before delay");

        (bool cancelledWhileFrozen,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(address(source), 0, abi.encodeCall(LoomAccount.cancelMigration, ()))
                        )
                    )
                )
            );
        require(!cancelledWhileFrozen, "frozen primary cancelled migration");
        require(source.migrationNonce() == 0, "failed frozen cancel advanced migration nonce");
        require(target.value() == 0, "frozen migration executed");

        vm.warp(source.frozenUntil());
        source.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(source), 0, abi.encodeCall(LoomAccount.cancelMigration, ())))
        );
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool executedAfterCancel,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!executedAfterCancel, "cancelled migration accepted");
    }

    function testGuardianThresholdCanCancelMigrationWithoutExecutionAuthority() public {
        LoomAccount source = _accountWithGuardianThreshold(2);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);

        LoomAccount.PendingMigration memory pending = _pending(source);
        bytes32 migrationId = source.migrationIdFor(pending);
        bytes32 digest = source.migrationCancelDigest(migrationId, pending.configVersion, pending.nonce);
        source.cancelMigrationWithGuardians(_guardianApprovals(source, digest));

        require(source.migrationNonce() == 1, "guardian cancel did not advance nonce");
        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        require(callsHash == bytes32(0), "guardian cancel did not clear pending migration");
        vm.warp(pending.readyAt);
        (bool executed,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!executed, "guardian-cancelled migration executed");
        require(target.value() == 0, "guardian cancellation executed calls");
    }

    function testGuardianMigrationCancellationRejectsDuplicateMissingAndWrongDigest() public {
        LoomAccount source = _accountWithGuardianThreshold(2);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);

        LoomAccount.PendingMigration memory pending = _pending(source);
        bytes32 migrationId = source.migrationIdFor(pending);
        bytes32 digest = source.migrationCancelDigest(migrationId, pending.configVersion, pending.nonce);

        LoomAccount.GuardianApproval[] memory missing = new LoomAccount.GuardianApproval[](1);
        LoomAccount.GuardianApproval[] memory approvals = _guardianApprovals(source, digest);
        missing[0] = approvals[0];
        (bool acceptedMissing,) =
            address(source).call(abi.encodeCall(LoomAccount.cancelMigrationWithGuardians, (missing)));
        require(!acceptedMissing, "missing guardian threshold accepted");

        LoomAccount.GuardianApproval[] memory duplicate = new LoomAccount.GuardianApproval[](2);
        duplicate[0] = approvals[0];
        duplicate[1] = approvals[0];
        (bool acceptedDuplicate,) =
            address(source).call(abi.encodeCall(LoomAccount.cancelMigrationWithGuardians, (duplicate)));
        require(!acceptedDuplicate, "duplicate guardian accepted");

        bytes32 wrongDigest = source.migrationCancelDigest(migrationId, pending.configVersion + 1, pending.nonce);
        (bool acceptedWrongDigest,) = address(source)
            .call(abi.encodeCall(LoomAccount.cancelMigrationWithGuardians, (_guardianApprovals(source, wrongDigest))));
        require(!acceptedWrongDigest, "wrong guardian digest accepted");

        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        require(callsHash == keccak256(abi.encode(calls)), "failed guardian cancel mutated pending migration");
        require(source.migrationNonce() == 0, "failed guardian cancel consumed nonce");
    }

    function testMigrationIsAtomicAndPreservesPendingStateOnRevert() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (7)));
        calls[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.fail, ()));

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool executed,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        require(!executed, "reverting migration succeeded");
        require(target.value() == 0, "migration was not atomic");
        require(source.migrationNonce() == 0, "reverting migration consumed nonce");
        (,,, bytes32 callsHash,,,,) = source.pendingMigration();
        require(callsHash == keccak256(abi.encode(calls)), "reverting migration cleared pending state");
    }

    function testMigrationRunsPolicyHooks() public {
        (LoomAccount source, PolicyHook hook) = _accountWithPolicyHook();
        LoomAccount destination = _account(false);
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);
        PolicyHook.Policy memory policy = PolicyHook.Policy(10, 10, 1 days, address(destination), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        _schedule(source, address(hook), setPolicy, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeScheduled(address(hook), 0, setPolicy);

        ExecutionLib.Execution[] memory overLimit = new ExecutionLib.Execution[](1);
        overLimit[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 11)));
        _scheduleMigration(source, destination, overLimit, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool acceptedOverLimit,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (overLimit)));
        require(!acceptedOverLimit, "migration bypassed policy hook");

        ExecutionLib.Execution[] memory allowed = new ExecutionLib.Execution[](1);
        allowed[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 10)));
        source.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(source), 0, abi.encodeCall(LoomAccount.cancelMigration, ())))
        );
        _scheduleMigration(source, destination, allowed, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeMigration(allowed);
        require(token.balanceOf(address(destination)) == 10, "allowed policy migration failed");
    }

    function _account(bool withPolicyHook) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](withPolicyHook ? 2 : 1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        if (withPolicyHook) modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(new PolicyHook()), "");
        return new LoomAccount(
            address(this), _guardianLeaf(), 1, keccak256(abi.encode("config", address(validator))), modules
        );
    }

    function _accountWithEntryPoint(address entryPoint) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        return new LoomAccount(
            entryPoint, _guardianLeaf(), 1, keccak256(abi.encode("config", entryPoint, address(validator))), modules
        );
    }

    function _accountWithPolicyHook() internal returns (LoomAccount account, PolicyHook hook) {
        MockValidator validator = new MockValidator();
        hook = new PolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        account = new LoomAccount(
            address(this), _guardianLeaf(), 1, keccak256(abi.encode("config", address(validator))), modules
        );
    }

    function _accountWithGuardianThreshold(uint8 threshold) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        return new LoomAccount(
            address(this),
            _guardianRoot(),
            threshold,
            keccak256(abi.encode("config", address(validator), threshold)),
            modules
        );
    }

    function _scheduleMigration(
        LoomAccount source,
        LoomAccount destination,
        ExecutionLib.Execution[] memory calls,
        uint48 delay,
        uint48 window
    ) internal {
        _scheduleMigrationTo(
            source, address(destination), address(destination).codehash, destination.configHash(), calls, delay, window
        );
    }

    function _scheduleMigrationTo(
        LoomAccount source,
        address destination,
        bytes32 destinationCodeHash,
        bytes32 destinationConfigHash,
        ExecutionLib.Execution[] memory calls,
        uint48 delay,
        uint48 window
    ) internal {
        bytes memory schedule = abi.encodeCall(
            LoomAccount.scheduleMigration,
            (destination, destinationCodeHash, destinationConfigHash, keccak256(abi.encode(calls)), delay, window)
        );
        source.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(source), 0, schedule)));
    }

    function _schedule(LoomAccount account, address target, bytes memory data, uint48 delay) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, delay));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
    }

    function _freeze(LoomAccount account) internal {
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("guardian-salt");
        bytes32 leaf =
            keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
        require(leaf == account.guardianRoot(), "unexpected guardian root");
        bytes32 domainSeparator = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(),
                keccak256("LoomAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(account.FREEZE_TYPEHASH(), leaf, account.freezeNonces(leaf), account.configVersion()));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, digest);
        account.freeze(address(guardianVerifier), keyCommitment, salt, new bytes32[](0), abi.encodePacked(r, s, v));
    }

    function _guardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _secondGuardianLeaf() internal returns (bytes32) {
        address guardian = vm.addr(SECOND_GUARDIAN_KEY);
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 salt = keccak256("second-guardian-salt");
        return keccak256(abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, salt));
    }

    function _guardianRoot() internal returns (bytes32) {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        return first <= second ? keccak256(abi.encodePacked(first, second)) : keccak256(abi.encodePacked(second, first));
    }

    function _guardianApprovals(LoomAccount account, bytes32 digest)
        internal
        returns (LoomAccount.GuardianApproval[] memory approvals)
    {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        approvals = new LoomAccount.GuardianApproval[](2);
        if (first <= second) {
            approvals[0] = _approval(account, GUARDIAN_KEY, "guardian-salt", second, digest);
            approvals[1] = _approval(account, SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
        } else {
            approvals[0] = _approval(account, SECOND_GUARDIAN_KEY, "second-guardian-salt", first, digest);
            approvals[1] = _approval(account, GUARDIAN_KEY, "guardian-salt", second, digest);
        }
    }

    function _approval(LoomAccount, uint256 privateKey, string memory saltText, bytes32 sibling, bytes32 digest)
        internal
        returns (LoomAccount.GuardianApproval memory approval)
    {
        address guardian = vm.addr(privateKey);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = LoomAccount.GuardianApproval({
            verifier: address(guardianVerifier),
            keyCommitment: keccak256(abi.encode(guardian)),
            salt: keccak256(bytes(saltText)),
            signature: _signature(privateKey, digest),
            proof: proof
        });
    }

    function _signature(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pending(LoomAccount account) internal view returns (LoomAccount.PendingMigration memory pending) {
        (
            pending.destination,
            pending.destinationCodeHash,
            pending.destinationConfigHash,
            pending.callsHash,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = account.pendingMigration();
    }

    receive() external payable {}
}

contract FutureNativeAccountLike {
    receive() external payable {}
}
