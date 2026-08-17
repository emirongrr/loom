// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockPolicyHook} from "../mocks/MockPolicyHook.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface Vm7702 {
    struct SignedDelegation {
        uint8 v;
        bytes32 r;
        bytes32 s;
        uint64 nonce;
        address implementation;
    }

    function addr(uint256 privateKey) external returns (address);
    function attachDelegation(SignedDelegation calldata signedDelegation) external;
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function signDelegation(address implementation, uint256 privateKey)
        external
        returns (SignedDelegation memory signedDelegation);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
}

contract EIP7702IntegrationTest {
    Vm7702 internal constant vm = Vm7702(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;

    function testDelegatedAccountInitializesOnceFromSelfAndUsesLoomExecution() public {
        EntryPoint entryPoint = new EntryPoint();
        MockPolicyHook hook = new MockPolicyHook();
        ECDSAValidator validator = new ECDSAValidator();
        MockTarget target = new MockTarget();
        address delegated = vm.addr(OWNER_KEY);
        _installSignedDelegation(delegated, address(entryPoint));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
        );

        require(
            _tryInitialize(address(0xB0B), delegated, address(entryPoint), modules) == false,
            "external caller initialized 7702 account"
        );
        require(_tryInitialize(delegated, delegated, address(entryPoint), modules), "self initialization failed");

        LoomAccount account = LoomAccount(payable(delegated));
        require(account.configVersion() == 1, "config version missing");
        require(account.configHash() == keccak256("7702-config"), "config hash missing");
        require(account.guardianRoot() == keccak256("guardians"), "guardian root missing");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "validator missing");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook missing");

        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (42))));
        uint48 validUntil = type(uint48).max;
        bytes32 digest = account.directExecutionDigest(
            address(validator), account.SINGLE_EXECUTION_MODE(), executionCalldata, 0, validUntil
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        account.executeDirect(
            address(validator),
            account.SINGLE_EXECUTION_MODE(),
            executionCalldata,
            validUntil,
            abi.encodePacked(r, s, v)
        );

        require(target.value() == 42, "delegated account execution failed");
    }

    function testSignedDelegationExecutesThroughEntryPointAndRejectsReplay() public {
        EntryPoint entryPoint = new EntryPoint();
        MockPolicyHook hook = new MockPolicyHook();
        ECDSAValidator validator = new ECDSAValidator();
        MockTarget target = new MockTarget();
        address delegated = vm.addr(OWNER_KEY);
        Vm7702.SignedDelegation memory authorization = _installSignedDelegation(delegated, address(entryPoint));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
        );
        require(_tryInitialize(delegated, delegated, address(entryPoint), modules), "self initialization failed");

        LoomAccount account = LoomAccount(payable(delegated));
        vm.deal(delegated, 2 ether);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signedUserOperation(entryPoint, account, validator, target, 84);

        address bundler = address(0xB0B);
        uint256 bundlerBalanceBefore = bundler.balance;
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();

        require(target.value() == 84, "delegated user operation not executed");
        require(entryPoint.getNonce(delegated, 0) == 1, "EntryPoint nonce not consumed");
        require(bundler.balance > bundlerBalanceBefore, "bundler beneficiary not paid");
        require(account.configVersion() == 1, "delegated account configuration changed");

        uint256 delegatedBalanceAfterExecution = delegated.balance;
        uint256 bundlerBalanceAfterExecution = bundler.balance;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce"));
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();

        require(target.value() == 84, "replayed operation changed target state");
        require(entryPoint.getNonce(delegated, 0) == 1, "replayed operation changed EntryPoint nonce");
        require(delegated.balance == delegatedBalanceAfterExecution, "replayed operation charged delegated account");
        require(bundler.balance == bundlerBalanceAfterExecution, "replayed operation paid bundler");

        vm.expectRevert(abi.encodeWithSelector(LoomAccount.InvalidInitialization.selector));
        vm.prank(delegated);
        account.initializeDelegatedAccount(
            address(entryPoint), keccak256("replacement-guardians"), 1, keccak256("replacement-config"), modules
        );
        require(account.configHash() == keccak256("7702-config"), "reinitialization changed config hash");
        require(account.configVersion() == 1, "reinitialization changed config version");

        bytes32 delegationCodeHash = keccak256(delegated.code);
        (bool replayAccepted, bytes memory replayError) =
            address(vm).call(abi.encodeCall(Vm7702.attachDelegation, (authorization)));
        require(!replayAccepted, "stale authorization accepted");
        require(
            keccak256(replayError)
                == keccak256(
                    abi.encodeWithSignature(
                        "CheatcodeError(string)",
                        "vm.attachDelegation: invalid nonce for 0xe05fcc23807536bee418f142d19fa0d21bb0cff7: expected 1, got 0"
                    )
                ),
            "wrong authorization replay rejection"
        );
        require(keccak256(delegated.code) == delegationCodeHash, "stale authorization changed delegation");
        require(account.configHash() == keccak256("7702-config"), "authorization replay changed account state");
    }

    /// @notice Regression: a third party must not be able to initialize an
    /// uninitialized EIP-7702 delegated EOA through the immutable-proxy bootstrap
    /// initializer.
    /// @dev `initialize` exists for `LoomAccountProxy`, which delegatecalls it from
    /// its own constructor, so it cannot require `msg.sender == address(this)`.
    /// Before the initialization-context guard it had no caller check at all, and an
    /// uninitialized delegated account has `configVersion == 0`, so anyone observing
    /// the delegation transaction could front-run the owner's self-initialization and
    /// install an attacker-chosen EntryPoint, validator, hook, and guardian
    /// configuration. `_initialize` then wrote `configVersion = 1`, so the real
    /// owner's `initializeDelegatedAccount` reverted forever: the takeover was
    /// permanent and every recovery path keyed off the attacker's guardian root.
    function testExternalCallerCannotInitializeUninitializedDelegatedAccount() public {
        EntryPoint entryPoint = new EntryPoint();
        MockPolicyHook attackerHook = new MockPolicyHook();
        ECDSAValidator attackerValidator = new ECDSAValidator();
        address delegated = vm.addr(OWNER_KEY);
        _installSignedDelegation(delegated, address(entryPoint));

        LoomAccount account = LoomAccount(payable(delegated));
        require(account.configVersion() == 0, "delegated account already initialized");

        address attacker = address(0xBAD);
        LoomAccount.ModuleInit[] memory attackerModules = new LoomAccount.ModuleInit[](2);
        attackerModules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(attackerHook), "");
        attackerModules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(attackerValidator),
            abi.encodeCall(ECDSAValidator.initialize, (attacker, address(attackerHook)))
        );

        vm.prank(attacker);
        (bool ok, bytes memory revertData) = delegated.call(
            abi.encodeCall(
                LoomAccount.initialize,
                (
                    address(entryPoint),
                    keccak256("attacker-guardians"),
                    uint8(1),
                    keccak256("attacker-config"),
                    attackerModules
                )
            )
        );

        require(!ok, "external caller initialized delegated account through proxy initializer");
        require(
            keccak256(revertData)
                == keccak256(abi.encodeWithSelector(LoomAccount.InvalidInitializationContext.selector)),
            "wrong rejection: initialization-context guard not reached"
        );

        // No configuration was installed, so the owner is not locked out.
        require(account.configVersion() == 0, "failed takeover advanced config version");
        require(account.configHash() == bytes32(0), "failed takeover wrote config hash");
        require(account.entryPoint() == address(0), "failed takeover wrote entry point");
        require(account.guardianRoot() == bytes32(0), "failed takeover wrote guardian root");
        require(account.guardianThreshold() == 0, "failed takeover wrote guardian threshold");
        require(account.validatorCount() == 0, "failed takeover installed a validator");
        require(
            !account.isModuleInstalled(ModuleType.VALIDATOR, address(attackerValidator)),
            "failed takeover installed attacker validator"
        );
        require(
            !account.isModuleInstalled(ModuleType.HOOK, address(attackerHook)),
            "failed takeover installed attacker hook"
        );

        // The legitimate owner can still take ownership through the self-only path.
        MockPolicyHook hook = new MockPolicyHook();
        ECDSAValidator validator = new ECDSAValidator();
        LoomAccount.ModuleInit[] memory ownerModules = new LoomAccount.ModuleInit[](2);
        ownerModules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        ownerModules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
        );
        require(
            _tryInitialize(delegated, delegated, address(entryPoint), ownerModules),
            "owner self initialization failed after rejected takeover"
        );
        require(account.guardianRoot() == keccak256("guardians"), "owner guardian root missing");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "owner validator missing");
    }

    /// @notice The runtime template a delegation points at must reject the bootstrap
    /// initializer on itself, so a delegation target can never be configured in place.
    function testTemplateRejectsProxyInitializer() public {
        EntryPoint entryPoint = new EntryPoint();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount template = new LoomAccount(
            address(entryPoint), keccak256("template-guardians"), 1, keccak256("template-config"), modules
        );

        (bool ok, bytes memory revertData) = address(template)
            .call(
                abi.encodeCall(
                    LoomAccount.initialize,
                    (
                        address(entryPoint),
                        keccak256("attacker-guardians"),
                        uint8(1),
                        keccak256("attacker-config"),
                        modules
                    )
                )
            );

        require(!ok, "template accepted proxy initializer");
        require(
            keccak256(revertData)
                == keccak256(abi.encodeWithSelector(LoomAccount.InvalidInitializationContext.selector)),
            "wrong rejection: initialization-context guard not reached on template"
        );
        require(template.configHash() == keccak256("template-config"), "template config changed");
        require(template.configVersion() == 1, "template config version changed");
    }

    function testConstructorInitializedAccountRejectsDelegatedInitializer() public {
        EntryPoint entryPoint = new EntryPoint();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account =
            new LoomAccount(address(entryPoint), keccak256("guardians"), 1, keccak256("config"), modules);

        vm.prank(address(account));
        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initializeDelegatedAccount,
                    (address(entryPoint), keccak256("new-guardians"), 1, keccak256("new-config"), modules)
                )
            );

        require(!ok, "constructor account reinitialized");
        require(account.configHash() == keccak256("config"), "constructor config changed");
    }

    /// @notice A delegated account keeps its whole configuration and its pending
    /// work when the EOA re-delegates to a different implementation.
    /// @dev This is the upgrade path for EIP-7702 accounts: adopting a new Loom
    /// generation costs one authorization signature rather than an asset migration,
    /// because the address and its storage persist. The property rests entirely on
    /// the storage block staying append-only, which `src/LoomAccount.sol:155`
    /// asserts in a comment and nothing else checked.
    ///
    /// Two separate assertions are needed and neither substitutes for the other.
    /// Sweeping every core slot before and after proves re-delegation does not clear
    /// storage. It cannot pin the declared order, because both implementations here
    /// share the same layout, so a reordering would shift both reads together.
    /// `_assertDeclaredLayout` is what pins the order: it compares raw slots against
    /// the getters, so moving a field fails here rather than silently breaking every
    /// re-delegated account.
    ///
    /// The account is driven past its initial configuration first - a second
    /// validator, a pending scheduled call, a pending migration - because a freshly
    /// initialized account would satisfy most of these assertions trivially.
    function testRedelegationPreservesConfigurationAndPendingState() public {
        EntryPoint entryPoint = new EntryPoint();
        MockPolicyHook hook = new MockPolicyHook();
        ECDSAValidator validator = new ECDSAValidator();
        MockTarget target = new MockTarget();
        address delegated = vm.addr(OWNER_KEY);
        _installSignedDelegation(delegated, address(entryPoint));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
        );
        require(_tryInitialize(delegated, delegated, address(entryPoint), modules), "self initialization failed");

        LoomAccount account = LoomAccount(payable(delegated));

        ECDSAValidator second = new ECDSAValidator();
        _scheduleAndRun(
            entryPoint,
            account,
            address(account),
            abi.encodeCall(
                LoomAccount.installModule,
                (
                    ModuleType.VALIDATOR,
                    address(second),
                    abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
                )
            ),
            3 days
        );
        require(account.validatorCount() == 2, "second validator not installed");
        require(account.configVersion() == 2, "module install did not advance configuration");

        bytes memory pendingData = abi.encodeCall(MockTarget.setValue, (7));
        _runThroughEntryPoint(
            entryPoint,
            account,
            address(account),
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), uint256(0), pendingData, uint48(1 days)))
        );
        bytes32 pendingId = keccak256(abi.encode(address(target), uint256(0), pendingData, account.configVersion()));

        MockTarget destination = new MockTarget();
        _runThroughEntryPoint(
            entryPoint,
            account,
            address(account),
            abi.encodeCall(
                LoomAccount.scheduleMigration,
                (
                    address(destination),
                    address(destination).codehash,
                    bytes32(0),
                    keccak256("migration-calls"),
                    uint48(3 days),
                    uint48(7 days)
                )
            )
        );

        _assertDeclaredLayout(account, "before re-delegation");
        bytes32[] memory slotsBefore = _coreSlots(delegated);
        uint64 versionBefore = account.configVersion();
        bytes32 configHashBefore = account.configHash();
        bytes32 guardianRootBefore = account.guardianRoot();
        uint8 thresholdBefore = account.guardianThreshold();
        address firstValidatorBefore = account.validatorAt(0);
        address secondValidatorBefore = account.validatorAt(1);
        (uint48 readyAtBefore, uint48 expiresAtBefore, uint64 opNonceBefore) = account.scheduledOperations(pendingId);
        require(readyAtBefore != 0, "scheduled call was not recorded");

        address newImplementation = _redelegate(delegated, address(entryPoint));
        require(newImplementation != address(0), "re-delegation did not install new code");

        // Every core slot, byte for byte. This is the assertion that pins the layout.
        bytes32[] memory slotsAfter = _coreSlots(delegated);
        for (uint256 i; i < slotsBefore.length; ++i) {
            require(slotsBefore[i] == slotsAfter[i], "core storage slot changed across re-delegation");
        }

        _assertDeclaredLayout(account, "after re-delegation");
        require(account.configVersion() == versionBefore, "configuration version changed");
        require(account.configHash() == configHashBefore, "configuration hash changed");
        require(account.guardianRoot() == guardianRootBefore, "guardian root changed");
        require(account.guardianThreshold() == thresholdBefore, "guardian threshold changed");
        require(account.entryPoint() == address(entryPoint), "entry point changed");
        require(account.validatorCount() == 2, "validator count changed");
        require(account.validatorAt(0) == firstValidatorBefore, "validator order changed at index 0");
        require(account.validatorAt(1) == secondValidatorBefore, "validator order changed at index 1");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook uninstalled by re-delegation");

        (uint48 readyAtAfter, uint48 expiresAtAfter, uint64 opNonceAfter) = account.scheduledOperations(pendingId);
        require(readyAtAfter == readyAtBefore, "scheduled call readiness changed");
        require(expiresAtAfter == expiresAtBefore, "scheduled call window changed");
        require(opNonceAfter == opNonceBefore, "scheduled call instance counter changed");

        (address migrationDestination,,,,,, uint64 migrationVersion,) = account.pendingMigration();
        require(migrationDestination == address(destination), "pending migration destination changed");
        require(migrationVersion == versionBefore, "pending migration configuration version changed");

        // Preserved state is not merely readable, it is still usable.
        vm.warp(block.timestamp + 1 days + 1);
        account.executeScheduled(address(target), 0, pendingData);
        require(target.value() == 7, "pending call did not survive re-delegation");

        // The new implementation cannot reinitialize an account that already exists.
        require(
            !_tryInitialize(delegated, delegated, address(entryPoint), modules),
            "re-delegated account accepted a second initialization"
        );

        // And the proxy bootstrap initializer stays closed: the delegated account has code.
        (bool bootstrapOk, bytes memory bootstrapRevert) = delegated.call(
            abi.encodeCall(
                LoomAccount.initialize,
                (address(entryPoint), keccak256("guardians"), uint8(1), keccak256("config"), modules)
            )
        );
        require(!bootstrapOk, "bootstrap initializer accepted on a re-delegated account");
        require(
            keccak256(bootstrapRevert)
                == keccak256(abi.encodeWithSelector(LoomAccount.InvalidInitializationContext.selector)),
            "wrong rejection: initialization-context guard not reached after re-delegation"
        );
    }

    /// @dev Pins the declared order of the core storage block by reading raw slots
    /// and comparing them against the getters that are supposed to describe them.
    /// A field that moves breaks this; a field appended at the end does not, which
    /// is exactly the append-only rule the block claims for itself.
    function _assertDeclaredLayout(LoomAccount account, string memory when) internal view {
        address target = address(account);
        require(
            address(uint160(uint256(vm.load(target, bytes32(uint256(0)))))) == account.entryPoint(),
            string.concat("slot 0 is not entryPoint ", when)
        );
        require(
            vm.load(target, bytes32(uint256(1))) == account.configHash(),
            string.concat("slot 1 is not configHash ", when)
        );
        require(
            uint64(uint256(vm.load(target, bytes32(uint256(2))))) == account.configVersion(),
            string.concat("slot 2 is not configVersion ", when)
        );
        require(
            vm.load(target, bytes32(uint256(3))) == account.guardianRoot(),
            string.concat("slot 3 is not guardianRoot ", when)
        );
        // Slot 4 packs guardianThreshold (uint8) and frozenUntil (uint48). Truncating
        // is the decode, not an accident: the whole point is to read the declared
        // widths back out of the packed word and compare them with the getters.
        uint256 packed = uint256(vm.load(target, bytes32(uint256(4))));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 packedThreshold = uint8(packed);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 packedFrozenUntil = uint48(packed >> 8);
        require(
            packedThreshold == account.guardianThreshold(),
            string.concat("slot 4 low byte is not guardianThreshold ", when)
        );
        require(packedFrozenUntil == account.frozenUntil(), string.concat("slot 4 is not frozenUntil ", when));
        require(
            uint256(vm.load(target, bytes32(uint256(9)))) == account.validatorCount(),
            string.concat("slot 9 is not validatorCount ", when)
        );
    }

    /// @dev Reads the core storage block as raw slots, to prove re-delegation does
    /// not clear them. Order is pinned separately by `_assertDeclaredLayout`.
    function _coreSlots(address account) internal view returns (bytes32[] memory slots) {
        slots = new bytes32[](21);
        for (uint256 i; i < slots.length; ++i) {
            slots[i] = vm.load(account, bytes32(i));
        }
    }

    /// @dev Points the same EOA at a freshly deployed implementation and returns it.
    function _redelegate(address delegated, address entryPoint) internal returns (address newImplementation) {
        MockValidator templateValidator = new MockValidator();
        LoomAccount.ModuleInit[] memory templateModules = new LoomAccount.ModuleInit[](1);
        templateModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(templateValidator), "");
        LoomAccount next = new LoomAccount(
            entryPoint, keccak256("next-generation-guardians"), 1, keccak256("next-generation-config"), templateModules
        );
        vm.attachDelegation(vm.signDelegation(address(next), OWNER_KEY));
        (bool authorizationTransactionOk,) = address(0).call("");
        require(authorizationTransactionOk, "re-delegation transaction reverted");
        require(
            keccak256(delegated.code) == keccak256(abi.encodePacked(hex"ef0100", address(next))),
            "re-delegation not installed"
        );
        newImplementation = address(next);
    }

    function _runThroughEntryPoint(EntryPoint entryPoint, LoomAccount account, address target, bytes memory data)
        internal
    {
        // Read the mode before pranking: a view call would consume the prank.
        bytes32 mode = account.SINGLE_EXECUTION_MODE();
        bytes memory executionCalldata = abi.encode(ExecutionLib.Execution(target, 0, data));
        vm.prank(address(entryPoint));
        account.execute(mode, executionCalldata);
    }

    function _scheduleAndRun(
        EntryPoint entryPoint,
        LoomAccount account,
        address target,
        bytes memory data,
        uint48 delay
    ) internal {
        _runThroughEntryPoint(
            entryPoint,
            account,
            address(account),
            abi.encodeCall(LoomAccount.scheduleCall, (target, uint256(0), data, delay))
        );
        vm.warp(block.timestamp + delay + 1);
        account.executeScheduled(target, 0, data);
    }

    function _installSignedDelegation(address delegated, address entryPoint)
        internal
        returns (Vm7702.SignedDelegation memory authorization)
    {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount template =
            new LoomAccount(entryPoint, keccak256("template-guardians"), 1, keccak256("template-config"), modules);
        authorization = vm.signDelegation(address(template), OWNER_KEY);
        vm.attachDelegation(authorization);
        (bool authorizationTransactionOk,) = address(0).call("");
        require(authorizationTransactionOk, "authorization transaction reverted");
        require(
            keccak256(delegated.code) == keccak256(abi.encodePacked(hex"ef0100", address(template))),
            "signed delegation not installed"
        );
    }

    function _signedUserOperation(
        EntryPoint entryPoint,
        LoomAccount account,
        ECDSAValidator validator,
        MockTarget target,
        uint256 value
    ) internal returns (PackedUserOperation memory op) {
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(
            address(target), 0, abi.encodeCall(MockTarget.setValue, (value))
        );
        op = PackedUserOperation({
            sender: address(account),
            nonce: entryPoint.getNonce(address(account), 0),
            initCode: abi.encodePacked(bytes20(bytes2(0x7702))),
            callData: abi.encodeCall(LoomAccount.execute, (account.SINGLE_EXECUTION_MODE(), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: abi.encode(address(validator), bytes(""))
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _tryInitialize(
        address sender,
        address delegated,
        address entryPoint,
        LoomAccount.ModuleInit[] memory modules
    ) internal returns (bool ok) {
        vm.prank(sender);
        (ok,) = delegated.call(
            abi.encodeCall(
                LoomAccount.initializeDelegatedAccount,
                (entryPoint, keccak256("guardians"), 1, keccak256("7702-config"), modules)
            )
        );
    }
}
