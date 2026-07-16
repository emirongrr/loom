// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

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
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function signDelegation(address implementation, uint256 privateKey)
        external
        returns (SignedDelegation memory signedDelegation);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
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
