// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {LoomAccountFactory} from "../src/account/LoomAccountFactory.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {SessionKeyValidator} from "../src/validators/SessionKeyValidator.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../src/libraries/ValidationDataLib.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {RevertingHook} from "./mocks/RevertingHook.sol";
import {ReentrantModule} from "./mocks/ReentrantModule.sol";
import {PaymasterAwareValidator} from "./mocks/PaymasterAwareValidator.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

interface VmSecurity {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract InvalidEntryPointMock {}

contract SecurityRegressionTest {
    VmSecurity internal constant vm = VmSecurity(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testSessionValidatorCannotAuthorizeERC1271() public {
        SessionKeyValidator validator = new SessionKeyValidator();
        LoomAccount account = _accountWithValidator(address(validator));
        bytes32 permissionId = keccak256("permission");

        bytes memory signature =
            abi.encode(address(validator), abi.encode(permissionId, bytes("signature"), bytes32(0)));
        require(account.isValidSignature(keccak256("arbitrary permit"), signature) == bytes4(0xffffffff));
    }

    function testPrimaryValidatorCannotAuthorizeArbitraryERC1271() public {
        ECDSAValidator validator = new ECDSAValidator();
        PolicyHook hook = new PolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(0xA11CE), address(hook)))
        );
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        bytes memory signature = abi.encode(address(validator), bytes("arbitrary signature"));
        require(account.isValidSignature(keccak256("arbitrary permit"), signature) == bytes4(0xffffffff));
    }

    function testMalformedERC1271SignatureReturnsInvalid() public {
        LoomAccount account = _accountWithValidator(address(new MockValidator()));
        require(account.isValidSignature(keccak256("hash"), hex"deadbeef") == bytes4(0xffffffff));
    }

    function testAccountPassesSelectedPaymasterToValidator() public {
        address paymaster = address(0xBEEF);
        PaymasterAwareValidator validator = new PaymasterAwareValidator(paymaster);
        LoomAccount account = _accountWithValidator(address(validator));
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(account),
            nonce: 0,
            initCode: "",
            callData: "",
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: abi.encodePacked(paymaster),
            signature: abi.encode(address(validator), bytes(""))
        });
        require(account.validateUserOp(userOp, keccak256("user-op"), 0) == 0, "selected paymaster not forwarded");

        userOp.paymasterAndData = "";
        require(
            account.validateUserOp(userOp, keccak256("user-op"), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "missing paymaster accepted"
        );
    }

    function testUserOperationValidationRejectsWrongSenderMalformedAndUninstalledValidator() public {
        MockValidator validator = new MockValidator();
        LoomAccount account = _accountWithValidator(address(validator));
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: address(0xBEEF),
            nonce: 0,
            initCode: "",
            callData: "",
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: abi.encode(address(validator), bytes(""))
        });
        require(
            account.validateUserOp(userOp, keccak256("wrong-sender"), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "wrong sender accepted"
        );

        userOp.sender = address(account);
        userOp.signature = hex"deadbeef";
        require(
            account.validateUserOp(userOp, keccak256("malformed"), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "malformed signature accepted"
        );

        userOp.signature = abi.encode(address(new MockValidator()), bytes(""));
        require(
            account.validateUserOp(userOp, keccak256("uninstalled"), 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "uninstalled validator accepted"
        );
    }

    function testCannotDeployAccountWithoutValidator() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](0);
        try new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules) {
            revert("validators required");
        } catch {}
    }

    function testFactoryRejectsDirectDeployment() public {
        MockEntryPoint entryPoint = new MockEntryPoint();
        LoomAccountFactory factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)));
        LoomAccount.ModuleInit[] memory modules = _modules(address(new MockValidator()));
        try factory.createAccount(keccak256("salt"), keccak256("guardians"), 1, keccak256("config"), modules) {
            revert("direct deployment accepted");
        } catch {}
    }

    function testInvalidEntryPointRejected() public {
        try new LoomAccountFactory(IEntryPoint(address(0xBEEF))) {
            revert("invalid entry point accepted");
        } catch {}

        try new LoomAccountFactory(IEntryPoint(address(new InvalidEntryPointMock()))) {
            revert("entry point without sender creator accepted");
        } catch {}
    }

    function testSingleGuardianFreezeCannotBeReplayedAndBlocksExecution() public {
        uint256 guardianKey = 0xA11CE;
        address guardian = vm.addr(guardianKey);
        ECDSAGuardianVerifier guardianVerifier = new ECDSAGuardianVerifier();
        bytes32 keyCommitment = keccak256(abi.encode(guardian));
        bytes32 guardianSalt = keccak256("guardian-salt");
        bytes32 guardianLeaf = keccak256(
            abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, guardianSalt)
        );
        LoomAccount account = new LoomAccount(
            address(this), guardianLeaf, 1, keccak256("config"), _modules(address(new MockValidator()))
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                account.EIP712_DOMAIN_TYPEHASH(),
                keccak256("LoomAccount"),
                keccak256("1"),
                block.chainid,
                address(account)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                account.FREEZE_TYPEHASH(), guardianLeaf, account.freezeNonces(guardianLeaf), account.configVersion()
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        account.freeze(address(guardianVerifier), keyCommitment, guardianSalt, new bytes32[](0), signature);
        // forge-lint: disable-next-line(block-timestamp)
        require(account.frozenUntil() > block.timestamp, "account not frozen");

        ExecutionLib.Execution memory transfer =
            ExecutionLib.Execution(address(new MockERC20()), 0, abi.encodeCall(MockERC20.mint, (address(this), 1)));
        (bool normalExecution,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(transfer))));
        require(!normalExecution, "frozen account executed normal call");

        (bool replayed,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.freeze,
                    (address(guardianVerifier), keyCommitment, guardianSalt, new bytes32[](0), signature)
                )
            );
        require(!replayed, "freeze replay accepted");

        ExecutionLib.Execution memory unfreeze =
            ExecutionLib.Execution(address(account), 0, abi.encodeCall(LoomAccount.unfreeze, ()));
        (bool earlyUnfreeze,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(unfreeze))));
        require(!earlyUnfreeze, "primary validator defeated guardian freeze");

        vm.warp(account.frozenUntil());
        account.execute(bytes32(0), abi.encode(unfreeze));
        require(account.frozenUntil() == 0, "expired freeze did not clear");
    }

    function testGuardianThresholdIsBounded() public {
        try new LoomAccount(
            address(this),
            keccak256("guardians"),
            type(uint8).max,
            keccak256("config"),
            _modules(address(new MockValidator()))
        ) {
            revert("unbounded guardian threshold accepted");
        } catch {}
    }

    function testERC20PolicyEnforcesPerCallAndPeriodLimits() public {
        PolicyHook hook = new PolicyHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockERC20 token = new MockERC20();
        token.mint(address(account), 1_000);

        PolicyHook.Policy memory policy = PolicyHook.Policy(60, 100, 1 days, address(0xBEEF), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        _scheduleAndExecute(account, address(hook), setPolicy, account.MIN_CONFIG_DELAY());

        _executeTokenTransfer(account, token, address(0xBEEF), 60);
        require(token.balanceOf(address(0xBEEF)) == 60);

        ExecutionLib.Execution memory overPeriod =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 50)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(overPeriod))));
        require(!ok, "period limit bypassed");

        ExecutionLib.Execution memory wrongRecipient =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 1)));
        (ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(wrongRecipient))));
        require(!ok, "counterparty restriction bypassed");
    }

    function testFuzzERC20PerCallLimit(uint128 amount) public {
        if (amount <= 10) return;
        PolicyHook hook = new PolicyHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockERC20 token = new MockERC20();
        token.mint(address(account), uint256(amount));

        PolicyHook.Policy memory policy = PolicyHook.Policy(10, type(uint128).max, 1 days, address(0xBEEF), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        _scheduleAndExecute(account, address(hook), setPolicy, account.MIN_CONFIG_DELAY());

        ExecutionLib.Execution memory transfer =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), amount)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(transfer))));
        require(!ok, "per-call token limit bypassed");
    }

    function testERC20ApprovePolicyRestrictsSpender() public {
        PolicyHook hook = new PolicyHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockERC20 token = new MockERC20();

        PolicyHook.Policy memory policy = PolicyHook.Policy(100, 100, 1 days, address(0xBEEF), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.approve.selector, policy));
        _scheduleAndExecute(account, address(hook), setPolicy, account.MIN_CONFIG_DELAY());

        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (address(0xBEEF), 100)))
            )
        );
        require(token.allowance(address(account), address(0xBEEF)) == 100, "allowed spender rejected");

        ExecutionLib.Execution memory wrongSpender =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (address(0xCAFE), 1)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(wrongSpender))));
        require(!ok, "spender restriction bypassed");
    }

    function testERC20TransferFromPolicyRestrictsRecipient() public {
        PolicyHook hook = new PolicyHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockERC20 token = new MockERC20();
        token.mint(address(this), 100);
        token.approve(address(account), 100);

        PolicyHook.Policy memory policy = PolicyHook.Policy(20, 40, 1 days, address(0xBEEF), true);
        bytes memory setPolicy =
            abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transferFrom.selector, policy));
        _scheduleAndExecute(account, address(hook), setPolicy, account.MIN_CONFIG_DELAY());

        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(token), 0, abi.encodeCall(MockERC20.transferFrom, (address(this), address(0xBEEF), 20))
                )
            )
        );
        require(token.balanceOf(address(0xBEEF)) == 20, "allowed recipient rejected");

        ExecutionLib.Execution memory wrongRecipient = ExecutionLib.Execution(
            address(token), 0, abi.encodeCall(MockERC20.transferFrom, (address(this), address(0xCAFE), 1))
        );
        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(wrongRecipient))));
        require(!ok, "transferFrom recipient restriction bypassed");
    }

    function testPolicyHookLowRiskClassification() public {
        (LoomAccount account, PolicyHook hook,) = _accountWithPolicyHook();
        MockERC20 token = new MockERC20();
        PolicyHook.Policy memory policy = PolicyHook.Policy(10, 20, 1 days, address(0xBEEF), true);
        _scheduleAndExecute(
            account,
            address(hook),
            abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy)),
            account.MIN_CONFIG_DELAY()
        );

        ExecutionLib.Execution memory allowed =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 10)));
        bytes memory allowedCall = abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(allowed)));
        require(hook.isLowRisk(address(account), allowedCall), "allowed policy call classified high risk");

        ExecutionLib.Execution memory overLimit =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 11)));
        bytes memory overLimitCall = abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(overLimit)));
        require(!hook.isLowRisk(address(account), overLimitCall), "over-limit call classified low risk");

        ExecutionLib.Execution[] memory batch = new ExecutionLib.Execution[](2);
        batch[0] = allowed;
        batch[1] = allowed;
        bytes32 batchMode = bytes32(uint256(1) << 248);
        require(
            hook.isLowRisk(address(account), abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(batch)))),
            "allowed batch classified high risk"
        );
        batch[1] = overLimit;
        require(
            !hook.isLowRisk(address(account), abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(batch)))),
            "mixed-risk batch classified low risk"
        );

        require(!hook.isLowRisk(address(account), bytes("short")), "malformed call classified low risk");
        require(
            !hook.isLowRisk(address(account), abi.encodeCall(LoomAccount.cancelScheduled, (bytes32(0)))),
            "non-execute call classified low risk"
        );
        bytes32 nonDefaultExecMode = bytes32(uint256(1) << 240);
        require(
            !hook.isLowRisk(
                address(account), abi.encodeCall(LoomAccount.execute, (nonDefaultExecMode, abi.encode(allowed)))
            ),
            "non-default execution classified low risk"
        );
        bytes32 unsupportedCallType = bytes32(uint256(2) << 248);
        require(
            !hook.isLowRisk(
                address(account), abi.encodeCall(LoomAccount.execute, (unsupportedCallType, abi.encode(allowed)))
            ),
            "unsupported call type classified low risk"
        );
        require(
            !hook.isLowRisk(
                address(account), abi.encodeCall(LoomAccount.execute, (bytes32(uint256(1)), abi.encode(allowed)))
            ),
            "trailing mode data classified low risk"
        );

        ExecutionLib.Execution[] memory emptyBatch = new ExecutionLib.Execution[](0);
        require(
            !hook.isLowRisk(address(account), abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(emptyBatch)))),
            "empty batch classified low risk"
        );
    }

    function testPolicyPeriodResetAndRemoval() public {
        (LoomAccount account, PolicyHook hook,) = _accountWithPolicyHook();
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        PolicyHook.Policy memory policy = PolicyHook.Policy(60, 60, 1 days, address(0), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        _scheduleAndExecute(account, address(hook), setPolicy, account.MIN_CONFIG_DELAY());

        _executeTokenTransfer(account, token, address(0xBEEF), 60);
        ExecutionLib.Execution memory next =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 1)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(next))));
        require(!ok, "period limit bypassed before reset");

        vm.warp(block.timestamp + 1 days);
        account.execute(bytes32(0), abi.encode(next));
        require(token.balanceOf(address(0xCAFE)) == 1, "period did not reset");

        bytes memory remove = abi.encodeCall(PolicyHook.removePolicy, (address(token), token.transfer.selector));
        _scheduleAndExecute(account, address(hook), remove, account.MIN_CONFIG_DELAY());
        require(
            !hook.isLowRisk(address(account), abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(next)))),
            "removed policy still classified low risk"
        );

        PolicyHook.Policy memory invalid = PolicyHook.Policy(1, 1, 0, address(0), true);
        (ok,) = address(hook)
            .call(abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, invalid)));
        require(!ok, "zero policy period accepted");
    }

    function testRejectedBatchRollsBackPolicySpending() public {
        (LoomAccount account, PolicyHook hook,) = _accountWithPolicyHook();
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        PolicyHook.Policy memory policy = PolicyHook.Policy(60, 60, 1 days, address(0xBEEF), true);
        _scheduleAndExecute(
            account,
            address(hook),
            abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy)),
            account.MIN_CONFIG_DELAY()
        );

        ExecutionLib.Execution[] memory batch = new ExecutionLib.Execution[](2);
        batch[0] = ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 60)));
        batch[1] = ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xCAFE), 1)));
        bytes32 batchMode = bytes32(uint256(1) << 248);
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(batch))));
        require(!ok, "invalid policy batch succeeded");
        require(token.balanceOf(address(0xBEEF)) == 0, "failed batch transferred tokens");

        _executeTokenTransfer(account, token, address(0xBEEF), 60);
        require(token.balanceOf(address(0xBEEF)) == 60, "failed batch consumed spending allowance");
    }

    function testScheduledExecutionCannotBypassActivePolicy() public {
        (LoomAccount account, PolicyHook hook,) = _accountWithPolicyHook();
        MockERC20 token = new MockERC20();
        token.mint(address(account), 100);
        PolicyHook.Policy memory policy = PolicyHook.Policy(10, 10, 1 days, address(0xBEEF), true);
        _scheduleAndExecute(
            account,
            address(hook),
            abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy)),
            account.MIN_CONFIG_DELAY()
        );

        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 11));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(token), 0, transfer, account.MIN_HIGH_RISK_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_HIGH_RISK_DELAY());

        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 0, transfer)));

        require(!ok, "scheduled execution bypassed policy");
        require(token.balanceOf(address(0xBEEF)) == 0, "scheduled execution transferred tokens");
    }

    function testRevertingHookCannotPermanentlyBrickAccount() public {
        RevertingHook hook = new RevertingHook();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        MockTarget target = new MockTarget();

        ExecutionLib.Execution memory normal =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(normal))));
        require(!ok, "reverting hook did not block normal execution");

        bytes memory arbitrarySchedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, bytes(""), account.MIN_HIGH_RISK_DELAY()));
        (ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, arbitrarySchedule)))
                )
            );
        require(!ok, "hook bypass accepted arbitrary schedule");

        bytes memory uninstallValidator =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes("")));
        bytes memory validatorRemovalSchedule = abi.encodeCall(
            LoomAccount.scheduleCall, (address(account), 0, uninstallValidator, account.MIN_CONFIG_DELAY())
        );
        (ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, validatorRemovalSchedule)))
                )
            );
        require(!ok, "hook bypass accepted validator removal");

        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));

        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, uninstall);
        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "reverting hook not removed");

        account.execute(bytes32(0), abi.encode(normal));
        require(target.value() == 1, "account did not recover after hook removal");
    }

    function testReentrantModuleInitializationRollsBack() public {
        LoomAccount account = _accountWithValidator(address(new MockValidator()));
        ReentrantModule module = new ReentrantModule();
        bytes memory install = abi.encodeCall(
            LoomAccount.installModule, (ModuleType.HOOK, address(module), abi.encodeCall(module.initialize, ()))
        );
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, install, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        uint64 versionBefore = account.configVersion();

        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, install)));
        require(!ok, "reentrant module installation succeeded");
        require(!account.isModuleInstalled(ModuleType.HOOK, address(module)), "failed module remained installed");
        require(account.configVersion() == versionBefore, "failed module installation changed config");
    }

    function _accountWithValidator(address validator) internal returns (LoomAccount) {
        return new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), _modules(validator));
    }

    function _accountWithPolicyHook() internal returns (LoomAccount account, PolicyHook hook, MockValidator validator) {
        hook = new PolicyHook();
        validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function _modules(address validator) internal pure returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, validator, "");
    }

    function _scheduleAndExecute(LoomAccount account, address target, bytes memory data, uint48 delay) internal {
        bytes memory schedule = abi.encodeCall(LoomAccount.scheduleCall, (target, 0, data, delay));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + delay);
        account.executeScheduled(target, 0, data);
    }

    function _executeTokenTransfer(LoomAccount account, MockERC20 token, address recipient, uint256 amount) internal {
        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (recipient, amount)))
            )
        );
    }
}
