// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
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

    function testMigrationCanBeCancelledAndIsFrozenSafeOnlyForCancellation() public {
        LoomAccount source = _account(true);
        LoomAccount destination = _account(false);
        MockTarget target = new MockTarget();
        ExecutionLib.Execution[] memory calls = new ExecutionLib.Execution[](1);
        calls[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));

        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        _freeze(source);
        (bool executedWhileFrozen,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!executedWhileFrozen, "frozen account executed migration before delay");

        source.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(source), 0, abi.encodeCall(LoomAccount.cancelMigration, ())))
        );
        require(source.migrationNonce() == 1, "cancel did not advance migration nonce");
        require(target.value() == 0, "cancelled migration executed");

        vm.warp(source.frozenUntil());
        _scheduleMigration(source, destination, calls, source.MIN_CONFIG_DELAY(), 1 days);
        source.execute(
            bytes32(0),
            abi.encode(ExecutionLib.Execution(address(source), 0, abi.encodeCall(LoomAccount.cancelMigration, ())))
        );
        vm.warp(block.timestamp + source.MIN_CONFIG_DELAY());
        (bool executedAfterCancel,) = address(source).call(abi.encodeCall(LoomAccount.executeMigration, (calls)));
        require(!executedAfterCancel, "cancelled migration accepted");
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

    function _scheduleMigration(
        LoomAccount source,
        LoomAccount destination,
        ExecutionLib.Execution[] memory calls,
        uint48 delay,
        uint48 window
    ) internal {
        bytes memory schedule = abi.encodeCall(
            LoomAccount.scheduleMigration,
            (
                address(destination),
                address(destination).codehash,
                destination.configHash(),
                keccak256(abi.encode(calls)),
                delay,
                window
            )
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

    receive() external payable {}
}
