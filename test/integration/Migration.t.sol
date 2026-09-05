// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {MigrationModule} from "../../src/MigrationModule.sol";
import {EIP712Lib} from "../../src/libraries/EIP712Lib.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {RevertingHook} from "../mocks/RevertingHook.sol";

interface VmMigration {
    function warp(uint256 timestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract MigrationTest {
    VmMigration internal constant vm = VmMigration(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant GUARDIAN_KEY = 0xA11CE;
    uint256 internal constant SECOND_GUARDIAN_KEY = 0xB0B;
    ECDSAGuardianVerifier internal guardianVerifier = new ECDSAGuardianVerifier();
    MigrationModule internal migrationModule = new MigrationModule();

    function testFuzzMigrationCancellationDigestPreservesAccountDomain(
        address account,
        bytes32 migrationId,
        uint64 version,
        uint64 nonce
    ) public view {
        bytes32 typeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 separator =
            keccak256(abi.encode(typeHash, keccak256("LoomAccount"), keccak256("1"), block.chainid, account));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CancelMigration(bytes32 migrationId,uint64 configVersion,uint64 nonce)"),
                migrationId,
                version,
                nonce
            )
        );
        require(
            migrationModule.migrationCancelDigest(account, migrationId, version, nonce)
                == keccak256(abi.encodePacked("\x19\x01", separator, structHash)),
            "account-bound cancellation digest changed"
        );
        require(
            EIP712Lib.domainSeparator(keccak256("LoomAccount"), keccak256("1"))
                == EIP712Lib.domainSeparator(keccak256("LoomAccount"), keccak256("1"), address(this)),
            "implicit domain overload changed"
        );
    }

    function testMigrationDelayMatchesAccountConfigurationDelay() public {
        LoomAccount source = _account(false);
        require(
            migrationModule.MIN_MIGRATION_DELAY() == source.MIN_CONFIG_DELAY(), "migration and account delays diverged"
        );
        require(migrationModule.isModuleType(ModuleType.MIGRATION), "migration module type rejected");
        require(!migrationModule.isModuleType(ModuleType.RECOVERY), "recovery module type accepted");
    }

    function testMigrationModuleRejectsCallsThatDoNotComeFromTheAccount() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        (bool accepted,) = address(migrationModule)
            .call(
                abi.encodeCall(
                    MigrationModule.scheduleMigration,
                    (
                        address(destination),
                        address(destination).codehash,
                        destination.configHash(),
                        keccak256("calls"),
                        source.MIN_CONFIG_DELAY(),
                        uint48(1 days)
                    )
                )
            );
        require(!accepted, "non-account caller scheduled a migration");
        (,,, bytes32 callsHash,,,,) = migrationModule.pendingMigrations(address(source));
        require(callsHash == bytes32(0), "rejected call created migration state");

        (bool consumeAccepted,) = address(migrationModule)
            .call(abi.encodeCall(MigrationModule.consumeMigration, (address(source), new ExecutionLib.Execution[](0))));
        require(!consumeAccepted, "external caller consumed account migration state");
    }

    function testMigrationModuleLifecycleIsTimelockedAndSingleInstance() public {
        LoomAccount source = _account(false);
        MigrationModule replacement = new MigrationModule();

        bytes memory install =
            abi.encodeCall(LoomAccount.installModule, (ModuleType.MIGRATION, address(replacement), bytes("")));
        _schedule(source, address(source), install, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool secondInstalled,) =
            address(source).call(abi.encodeCall(LoomAccount.executeScheduled, (address(source), 0, install)));
        require(!secondInstalled, "second migration module was installed");
        require(source.migrationModule() == address(migrationModule), "active migration module changed");

        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.MIGRATION, address(migrationModule), bytes("")));
        _schedule(source, address(source), uninstall, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeScheduled(address(source), 0, uninstall);
        require(source.migrationModule() == address(0), "migration module address was not cleared");
        require(
            !source.isModuleInstalled(ModuleType.MIGRATION, address(migrationModule)),
            "migration module remained installed"
        );
    }

    function testPendingMigrationCannotBeOverwritten() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(destination), 0, bytes(""));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);

        (,,, bytes32 committedCallsHash,,,,) = migrationModule.pendingMigrations(address(source));
        bytes memory schedule = abi.encodeCall(
            MigrationModule.scheduleMigration,
            (
                address(destination),
                address(destination).codehash,
                destination.configHash(),
                keccak256(abi.encode(calls)),
                source.MIN_CONFIG_DELAY(),
                uint48(1 days)
            )
        );
        (bool overwritten,) = address(source)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(migrationModule), 0, schedule)))
                )
            );

        require(!overwritten, "pending migration was overwritten");
        (,,, bytes32 callsHashAfter,,,,) = migrationModule.pendingMigrations(address(source));
        require(callsHashAfter == committedCallsHash, "pending migration commitment changed");
    }

    function testMigrationModuleUninstallRequiresExplicitCancellation() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(destination), 0, bytes(""));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        uint64 version = source.configVersion();
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.MIGRATION, address(migrationModule), bytes("")));
        _schedule(source, address(source), uninstall, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool removed, bytes memory reason) =
            address(source).call(abi.encodeCall(LoomAccount.executeScheduled, (address(source), 0, uninstall)));
        require(!removed, "pending migration module was uninstalled");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LoomAccount.InvalidModule.selector)),
            "unexpected uninstall rejection"
        );
        require(source.configVersion() == version, "rejected uninstall changed configuration");
        require(source.migrationModule() == address(migrationModule), "rejected uninstall cleared module");
        require(_pending(source).callsHash == keccak256(abi.encode(calls)), "rejected uninstall changed pending record");

        source.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(migrationModule), 0, abi.encodeCall(MigrationModule.cancelMigration, ()))
            )
        );
        source.executeScheduled(address(source), 0, uninstall);
        require(source.migrationModule() == address(0), "cancelled module did not uninstall");
        bytes memory install =
            abi.encodeCall(LoomAccount.installModule, (ModuleType.MIGRATION, address(migrationModule), bytes("")));
        _schedule(source, address(source), install, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeScheduled(address(source), 0, install);
        require(_pending(source).readyAt == 0, "reinstall restored pending state");
        require(migrationModule.migrationNonces(address(source)) == 1, "cancellation nonce did not persist");
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeMigration(calls);
        require(migrationModule.migrationNonces(address(source)) == 2, "fresh migration failed after reinstall");
    }

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
        (address pendingDestination,,, bytes32 callsHash, uint48 readyAt,,,) =
            migrationModule.pendingMigrations(address(source));
        require(pendingDestination == address(destination), "destination not committed");
        require(callsHash == keccak256(abi.encode(calls)), "calls hash not committed");

        (bool early,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!early, "migration executed before delay");

        vm.warp(readyAt);
        source.executeMigration(calls);

        require(token.balanceOf(address(destination)) == 70, "token migration failed");
        require(address(destination).balance == 1 ether, "eth migration failed");
        require(migrationModule.migrationNonces(address(source)) == 1, "migration nonce did not advance");
        (,,, bytes32 clearedHash,,,,) = migrationModule.pendingMigrations(address(source));
        require(clearedHash == bytes32(0), "pending migration not cleared");
    }

    /// @notice The committed destination is a declaration, not an execution constraint.
    /// @dev `executeMigration` checks the calls hash and re-verifies the destination's
    /// code hash, but nothing requires any call in the batch to target the
    /// destination. This is deliberate -- it keeps the exit usable for destinations
    /// that are not Loom accounts -- but it means the commitment cannot be read as a
    /// guarantee that assets arrived there, which is why
    /// `docs/design/lifecycle.md` says so explicitly. Pinned here so the claim is
    /// backed by behaviour rather than by prose.
    function testMigrationBatchIgnoringItsCommittedDestinationIsAccepted() public {
        LoomAccount source = _account(false);
        LoomAccount destination = _account(false);
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);

        address elsewhere = address(0xBEEF);
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (elsewhere, 100)));

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        (address pendingDestination,,,, uint48 readyAt,,,) = migrationModule.pendingMigrations(address(source));
        require(pendingDestination == address(destination), "destination not committed");

        vm.warp(readyAt);
        source.executeMigration(calls);

        // Everything went somewhere other than the committed destination, and the
        // migration still completed.
        require(token.balanceOf(elsewhere) == 100, "assets did not move to the third party");
        require(token.balanceOf(address(destination)) == 0, "committed destination received assets");
        require(migrationModule.migrationNonces(address(source)) == 1, "migration nonce did not advance");

        // And the source account is still fully operational: migration is a delayed
        // exit batch, not a terminal state.
        require(source.validatorCount() != 0, "source account lost its validators");
        (,,, bytes32 clearedHash,,,,) = migrationModule.pendingMigrations(address(source));
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

    function testMigrationBatchCannotUninstallTheLastValidator() public {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(migrationModule), "");
        LoomAccount source =
            new LoomAccount(address(this), _guardianLeaf(), 1, keccak256("config-last-validator"), modules);
        LoomAccount destination = _account(false);

        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](2);
        calls[0] = ExecutionLib.Execution(
            address(source),
            0,
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), ""))
        );
        calls[1] = ExecutionLib.Execution(
            address(source),
            0,
            abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(new MockValidator()), ""))
        );

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool ok,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));

        require(!ok, "migration batch installed/uninstalled a validator");
        require(source.validatorCount() == 1, "validator count changed by a reverted migration");
        require(source.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "original validator removed");
    }

    function testGuardianThresholdCanEvictAStuckHookImmediately() public {
        RevertingHook hook = new RevertingHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount source = new LoomAccount(
            address(this), _guardianRoot(), 2, keccak256(abi.encode("config", address(validator))), modules
        );
        MockTarget target = new MockTarget();

        ExecutionLib.Execution memory normal =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        (bool blocked,) = address(source).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(normal))));
        require(!blocked, "reverting hook did not block normal execution");

        bytes32 digest = source.evictHookDigest(address(hook), address(0), source.configVersion());
        GuardianVerificationLib.Approval[] memory single = new GuardianVerificationLib.Approval[](1);
        single[0] = _approval(source, GUARDIAN_KEY, "guardian-salt", _secondGuardianLeaf(), digest);
        (bool acceptedSingle,) = address(source)
            .call(abi.encodeCall(LoomAccount.evictHookWithGuardians, (address(hook), address(0), single)));
        require(!acceptedSingle, "below-threshold guardian approval evicted hook");

        source.evictHookWithGuardians(address(hook), address(0), _guardianApprovals(source, digest));

        require(!source.isModuleInstalled(ModuleType.HOOK, address(hook)), "stuck hook not evicted");
        (bool nowAllowed,) = address(source).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(normal))));
        require(nowAllowed, "execution still blocked after guardian eviction");
        require(target.value() == 1, "evicted-hook execution did not run");
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
                                address(migrationModule),
                                0,
                                abi.encodeCall(
                                    MigrationModule.scheduleMigration,
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
                                address(migrationModule),
                                0,
                                abi.encodeCall(
                                    MigrationModule.scheduleMigration,
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
                                address(migrationModule),
                                0,
                                abi.encodeCall(
                                    MigrationModule.scheduleMigration,
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
                                address(migrationModule),
                                0,
                                abi.encodeCall(
                                    MigrationModule.scheduleMigration,
                                    (
                                        address(destination),
                                        address(destination).codehash,
                                        destination.configHash(),
                                        keccak256(abi.encode(calls)),
                                        source.MIN_CONFIG_DELAY(),
                                        migrationModule.MAX_MIGRATION_WINDOW() + 1
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
                                address(migrationModule),
                                0,
                                abi.encodeCall(
                                    MigrationModule.scheduleMigration,
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
                            ExecutionLib.Execution(
                                address(migrationModule), 0, abi.encodeCall(MigrationModule.cancelMigration, ())
                            )
                        )
                    )
                )
            );
        require(!cancelledWhileFrozen, "frozen primary cancelled migration");
        require(migrationModule.migrationNonces(address(source)) == 0, "failed frozen cancel advanced migration nonce");
        require(target.value() == 0, "frozen migration executed");

        vm.warp(source.frozenUntil());
        source.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(migrationModule), 0, abi.encodeCall(MigrationModule.cancelMigration, ()))
            )
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

        MigrationModule.PendingMigration memory pending = _pending(source);
        bytes32 migrationId = migrationModule.migrationIdFor(address(source), pending);
        bytes32 digest =
            migrationModule.migrationCancelDigest(address(source), migrationId, pending.configVersion, pending.nonce);
        migrationModule.cancelMigrationWithGuardians(address(source), _guardianApprovals(source, digest));

        require(migrationModule.migrationNonces(address(source)) == 1, "guardian cancel did not advance nonce");
        (,,, bytes32 callsHash,,,,) = migrationModule.pendingMigrations(address(source));
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

        MigrationModule.PendingMigration memory pending = _pending(source);
        bytes32 migrationId = migrationModule.migrationIdFor(address(source), pending);
        bytes32 digest =
            migrationModule.migrationCancelDigest(address(source), migrationId, pending.configVersion, pending.nonce);

        GuardianVerificationLib.Approval[] memory missing = new GuardianVerificationLib.Approval[](1);
        GuardianVerificationLib.Approval[] memory approvals = _guardianApprovals(source, digest);
        missing[0] = approvals[0];
        (bool acceptedMissing,) = address(migrationModule)
            .call(abi.encodeCall(MigrationModule.cancelMigrationWithGuardians, (address(source), missing)));
        require(!acceptedMissing, "missing guardian threshold accepted");

        GuardianVerificationLib.Approval[] memory duplicate = new GuardianVerificationLib.Approval[](2);
        duplicate[0] = approvals[0];
        duplicate[1] = approvals[0];
        (bool acceptedDuplicate,) = address(migrationModule)
            .call(abi.encodeCall(MigrationModule.cancelMigrationWithGuardians, (address(source), duplicate)));
        require(!acceptedDuplicate, "duplicate guardian accepted");

        bytes32 wrongDigest = migrationModule.migrationCancelDigest(
            address(source), migrationId, pending.configVersion + 1, pending.nonce
        );
        (bool acceptedWrongDigest,) = address(migrationModule)
            .call(
                abi.encodeCall(
                    MigrationModule.cancelMigrationWithGuardians,
                    (address(source), _guardianApprovals(source, wrongDigest))
                )
            );
        require(!acceptedWrongDigest, "wrong guardian digest accepted");

        (,,, bytes32 callsHash,,,,) = migrationModule.pendingMigrations(address(source));
        require(callsHash == keccak256(abi.encode(calls)), "failed guardian cancel mutated pending migration");
        require(migrationModule.migrationNonces(address(source)) == 0, "failed guardian cancel consumed nonce");
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
        require(migrationModule.migrationNonces(address(source)) == 0, "reverting migration consumed nonce");
        (,,, bytes32 callsHash,,,,) = migrationModule.pendingMigrations(address(source));
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
            abi.encode(
                ExecutionLib.Execution(address(migrationModule), 0, abi.encodeCall(MigrationModule.cancelMigration, ()))
            )
        );
        _scheduleMigration(source, destination, allowed, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeMigration(allowed);
        require(token.balanceOf(address(destination)) == 10, "allowed policy migration failed");
    }

    function testMigrationNormalizesEquivalentOuterArrayEncoding() public {
        (LoomAccount source, PolicyHook hook) = _accountWithPolicyHook();
        LoomAccount destination = _account(false);
        MockERC20 token = new MockERC20();
        token.mint(address(source), 100);
        bytes memory setPolicy = abi.encodeCall(
            PolicyHook.setPolicy,
            (address(token), token.transfer.selector, PolicyHook.Policy(10, 10, 1 days, address(destination), true))
        );
        _schedule(source, address(hook), setPolicy, source.MIN_CONFIG_DELAY());
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        source.executeScheduled(address(hook), 0, setPolicy);
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(destination), 10)));
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());

        // Move the outer array from byte 32 to byte 64 with one padding word.
        bytes memory arguments = abi.encodePacked(uint256(64), abi.encode(calls));
        require(
            keccak256(abi.encode(abi.decode(arguments, (ExecutionLib.Execution[])))) == keccak256(abi.encode(calls)),
            "fixture changed decoded calls"
        );
        (bool executed,) = address(source).call(abi.encodePacked(LoomAccount.executeMigration.selector, arguments));
        require(executed, "equivalent migration encoding rejected");
        require(token.balanceOf(address(destination)) == 10, "normalized migration changed transfer");
        require(_pending(source).readyAt == 0, "normalized migration did not consume record");
        require(migrationModule.migrationNonces(address(source)) == 1, "normalized migration nonce changed");
        (bool replayed,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!replayed, "canonical representation replayed consumed migration");
    }

    function _account(bool withPolicyHook) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](withPolicyHook ? 3 : 2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        if (withPolicyHook) modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(new PolicyHook()), "");
        modules[modules.length - 1] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(migrationModule), "");
        return new LoomAccount(
            address(this), _guardianLeaf(), 1, keccak256(abi.encode("config", address(validator))), modules
        );
    }

    function _accountWithEntryPoint(address entryPoint) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(migrationModule), "");
        return new LoomAccount(
            entryPoint, _guardianLeaf(), 1, keccak256(abi.encode("config", entryPoint, address(validator))), modules
        );
    }

    function _accountWithPolicyHook() internal returns (LoomAccount account, PolicyHook hook) {
        MockValidator validator = new MockValidator();
        hook = new PolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[2] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(migrationModule), "");
        account = new LoomAccount(
            address(this), _guardianLeaf(), 1, keccak256(abi.encode("config", address(validator))), modules
        );
    }

    function _accountWithGuardianThreshold(uint8 threshold) internal returns (LoomAccount) {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.MIGRATION, address(migrationModule), "");
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
            MigrationModule.scheduleMigration,
            (destination, destinationCodeHash, destinationConfigHash, keccak256(abi.encode(calls)), delay, window)
        );
        source.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(migrationModule), 0, schedule)));
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
        returns (GuardianVerificationLib.Approval[] memory approvals)
    {
        bytes32 first = _guardianLeaf();
        bytes32 second = _secondGuardianLeaf();
        approvals = new GuardianVerificationLib.Approval[](2);
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
        returns (GuardianVerificationLib.Approval memory approval)
    {
        address guardian = vm.addr(privateKey);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        approval = GuardianVerificationLib.Approval({
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

    function _pending(LoomAccount account) internal view returns (MigrationModule.PendingMigration memory pending) {
        (
            pending.destination,
            pending.destinationCodeHash,
            pending.destinationConfigHash,
            pending.callsHash,
            pending.readyAt,
            pending.expiresAt,
            pending.configVersion,
            pending.nonce
        ) = migrationModule.pendingMigrations(address(account));
    }

    receive() external payable {}
}

contract FutureNativeAccountLike {
    receive() external payable {}
}
