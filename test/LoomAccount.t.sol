// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {LoomAccountFactory} from "../src/account/LoomAccountFactory.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPolicyHook} from "./mocks/MockPolicyHook.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {Base64Url} from "../src/libraries/Base64Url.sol";
import {SessionKeyValidator} from "../src/validators/SessionKeyValidator.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {ValidationDataLib} from "../src/libraries/ValidationDataLib.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

interface Vm {
    function warp(uint256) external;
    function deal(address account, uint256 amount) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract LoomAccountTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LoomAccount internal account;
    MockTarget internal target;
    MockValidator internal validator;

    function setUp() public {
        validator = new MockValidator();
        target = new MockTarget();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function testSingleExecution() public {
        ExecutionLib.Execution memory item =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (7)));
        account.execute(bytes32(0), abi.encode(item));
        require(target.value() == 7, "single execution failed");
    }

    function testBatchIsAtomic() public {
        ExecutionLib.Execution[] memory items = new ExecutionLib.Execution[](2);
        items[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (9)));
        items[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.fail, ()));

        bytes32 batchMode = bytes32(uint256(1) << 248);
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(items))));
        require(!ok, "batch should revert");
        require(target.value() == 0, "batch was not atomic");
    }

    function testBatchExecutesInOrder() public {
        ExecutionLib.Execution[] memory items = new ExecutionLib.Execution[](2);
        items[0] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (9)));
        items[1] = ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (10)));

        bytes32 batchMode = bytes32(uint256(1) << 248);
        account.execute(batchMode, abi.encode(items));
        require(target.value() == 10, "batch execution order changed");
    }

    function testBatchValueTransfersAndInsufficientBalanceRollsBack() public {
        MockTarget secondTarget = new MockTarget();
        vm.deal(address(account), 1 ether);
        ExecutionLib.Execution[] memory items = new ExecutionLib.Execution[](2);
        items[0] = ExecutionLib.Execution(address(target), 0.4 ether, abi.encodeCall(MockTarget.setValue, (1)));
        items[1] = ExecutionLib.Execution(address(secondTarget), 0.6 ether, abi.encodeCall(MockTarget.setValue, (2)));

        bytes32 batchMode = bytes32(uint256(1) << 248);
        account.execute(batchMode, abi.encode(items));
        require(address(target).balance == 0.4 ether, "first batch value missing");
        require(address(secondTarget).balance == 0.6 ether, "second batch value missing");

        vm.deal(address(account), 1 ether);
        items[0] = ExecutionLib.Execution(address(target), 0.6 ether, abi.encodeCall(MockTarget.setValue, (3)));
        items[1] = ExecutionLib.Execution(address(secondTarget), 0.6 ether, abi.encodeCall(MockTarget.setValue, (4)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(items))));
        require(!ok, "underfunded batch succeeded");
        require(target.value() == 1 && secondTarget.value() == 2, "underfunded batch was not atomic");
        require(address(account).balance == 1 ether, "underfunded batch spent account funds");
    }

    function testBatchCanFundAndExecuteInOneCall() public {
        ExecutionLib.Execution[] memory items = new ExecutionLib.Execution[](1);
        items[0] = ExecutionLib.Execution(address(target), 1 ether, abi.encodeCall(MockTarget.setValue, (12)));
        account.execute{value: 1 ether}(account.BATCH_EXECUTION_MODE(), abi.encode(items));
        require(address(target).balance == 1 ether, "funded batch value missing");
        require(target.value() == 12, "funded batch call failed");
    }

    function testEmptyBatchAndZeroTargetRevert() public {
        bytes32 batchMode = bytes32(uint256(1) << 248);
        ExecutionLib.Execution[] memory empty = new ExecutionLib.Execution[](0);
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (batchMode, abi.encode(empty))));
        require(!ok, "empty batch accepted");

        ExecutionLib.Execution memory zeroTarget = ExecutionLib.Execution(address(0), 0, "");
        (ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(zeroTarget))));
        require(!ok, "zero target accepted");
    }

    function testExecutionCapabilitiesAndCallerAuthorization() public {
        bytes32 batchMode = bytes32(uint256(1) << 248);
        bytes32 nonDefaultExecMode = bytes32(uint256(1) << 240);
        bytes32 unsupportedCallType = bytes32(uint256(2) << 248);
        bytes32 trailingModeData = bytes32(uint256(1));
        require(account.supportsExecutionMode(bytes32(0)), "single mode unsupported");
        require(account.supportsExecutionMode(batchMode), "batch mode unsupported");
        require(!account.supportsExecutionMode(nonDefaultExecMode), "non-default exec mode supported");
        require(!account.supportsExecutionMode(unsupportedCallType), "unsupported call type supported");
        require(!account.supportsExecutionMode(trailingModeData), "trailing mode data supported");

        ExecutionLib.Execution memory item =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (11)));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (trailingModeData, abi.encode(item))));
        require(!ok, "trailing mode data executed");

        LoomAccount foreignAccount = new LoomAccount(
            address(new MockEntryPoint()), keccak256("guardians"), 1, keccak256("config"), _modules(validator)
        );
        (ok,) = address(foreignAccount).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(item))));
        require(!ok, "unauthorized caller executed account");
        require(target.value() == 0, "unauthorized execution changed state");
    }

    function testTokenReceiverCapabilities() public view {
        require(account.supportsInterface(account.ERC165_INTERFACE_ID()), "ERC-165 unsupported");
        require(account.supportsInterface(account.ERC721_RECEIVER_INTERFACE_ID()), "ERC-721 receiver unsupported");
        require(account.supportsInterface(account.ERC1155_RECEIVER_INTERFACE_ID()), "ERC-1155 receiver unsupported");
        require(!account.supportsInterface(0xffffffff), "unknown interface supported");
        require(
            account.onERC721Received(address(this), address(this), 1, "") == account.ERC721_RECEIVER_INTERFACE_ID(),
            "ERC-721 callback rejected"
        );
        require(
            account.onERC1155Received(address(this), address(this), 1, 1, "") == account.onERC1155Received.selector,
            "ERC-1155 callback rejected"
        );
        require(
            account.onERC1155BatchReceived(address(this), address(this), new uint256[](0), new uint256[](0), "")
                == account.onERC1155BatchReceived.selector,
            "ERC-1155 batch callback rejected"
        );
    }

    function testUnsupportedExecutionModeReverts() public {
        ExecutionLib.Execution memory item =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (1)));
        bytes32 unsupported = bytes32(uint256(2) << 248);
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (unsupported, abi.encode(item))));
        require(!ok, "unsupported mode accepted");
    }

    function testConfigCannotBypassTimelock() public {
        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-guardians"), uint8(1))));
        require(!ok, "config timelock bypassed");
        require(account.configVersion() == 1, "config changed");
    }

    function testNoExecutorOrFallbackModules() public view {
        require(!account.isModuleInstalled(ModuleType.EXECUTOR, address(validator)), "executor installed");
        require(!account.isModuleInstalled(ModuleType.FALLBACK, address(validator)), "fallback installed");
    }

    function testConfigChangeRequiresAndHonorsDelay() public {
        bytes32 newRoot = keccak256("new-guardians");
        bytes memory update = abi.encodeCall(LoomAccount.setGuardianConfig, (newRoot, uint8(1)));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, update, account.MIN_CONFIG_DELAY()));
        ExecutionLib.Execution memory item = ExecutionLib.Execution(address(account), 0, schedule);
        account.execute(bytes32(0), abi.encode(item));

        (bool early,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, update)));
        require(!early, "config executed before delay");

        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, update);
        require(account.configVersion() == 2, "config did not execute");
        require(account.guardianRoot() == newRoot, "guardian root did not change");
    }

    function testScheduledCallCanBeCancelled() public {
        bytes memory callData = abi.encodeCall(MockTarget.setValue, (99));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, callData, account.MIN_HIGH_RISK_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        bytes32 operationId = keccak256(abi.encode(address(target), 0, callData, account.configVersion()));

        bytes memory cancel = abi.encodeCall(LoomAccount.cancelScheduled, (operationId));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, cancel)));
        vm.warp(block.timestamp + account.MIN_HIGH_RISK_DELAY());
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, callData)));
        require(!ok, "cancelled operation executed");
    }

    function testConfigChangeInvalidatesPreviouslyScheduledOperation() public {
        bytes memory targetCall = abi.encodeCall(MockTarget.setValue, (99));
        bytes memory scheduleTarget =
            abi.encodeCall(LoomAccount.scheduleCall, (address(target), 0, targetCall, account.MIN_HIGH_RISK_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleTarget)));

        bytes memory update = abi.encodeCall(LoomAccount.setGuardianConfig, (keccak256("new-guardians"), uint8(1)));
        bytes memory scheduleUpdate =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, update, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleUpdate)));

        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, update);
        require(account.configVersion() == 2, "config did not advance");

        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(target), 0, targetCall)));
        require(!ok, "stale scheduled operation executed");
        require(target.value() == 0, "stale operation changed state");
    }

    function testTokenAllowanceCanBeRevoked() public {
        MockERC20 token = new MockERC20();
        address spender = address(0xBEEF);
        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.approve, (spender, uint256(100))))
            )
        );
        require(token.allowance(address(account), spender) == 100, "allowance not set");

        bytes memory revoke = abi.encodeCall(LoomAccount.revokeTokenAllowance, (address(token), spender));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, revoke)));
        require(token.allowance(address(account), spender) == 0, "allowance not revoked");

        bytes memory invalidRevoke = abi.encodeCall(LoomAccount.revokeTokenAllowance, (address(0), spender));
        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, invalidRevoke)))
                )
            );
        require(!ok, "zero token allowance revoke accepted");
    }

    function testLastValidatorCannotBeRemoved() public {
        bytes memory uninstall =
            abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.VALIDATOR, address(validator), bytes("")));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));

        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));
        require(!ok, "last validator removed");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "last validator missing");
        require(account.configVersion() == 1, "failed validator removal changed config");
    }

    function _modules(MockValidator moduleValidator) internal pure returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(moduleValidator), "");
    }
}

contract Base64UrlTest {
    function testEncode32() public pure {
        require(
            keccak256(Base64Url.encode32(bytes32(0)))
                == keccak256(bytes("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
            "zero encoding mismatch"
        );
        require(
            keccak256(Base64Url.encode32(bytes32(type(uint256).max)))
                == keccak256(bytes("__________________________________________8")),
            "max encoding mismatch"
        );
    }
}

contract LoomAccountFactoryTest {
    function testFactoryAddressIsDeterministic() public {
        MockEntryPoint entryPoint = new MockEntryPoint();
        LoomAccountFactory factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)));
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 salt = keccak256("loom-test");
        address predicted = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        LoomAccount deployed =
            entryPoint.createAccount(factory, salt, keccak256("guardians"), 1, keccak256("config"), modules);
        require(address(deployed) == predicted, "unexpected create2 address");
        require(
            address(entryPoint.createAccount(factory, salt, keccak256("guardians"), 1, keccak256("config"), modules))
                == predicted,
            "not idempotent"
        );
    }
}

contract SessionKeyValidatorTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testPermissionBindsCallAndUseLimit() public {
        uint256 sessionKey = 0xB0B;
        address signer = vm.addr(sessionKey);
        SessionKeyValidator validator = new SessionKeyValidator();
        MockTarget target = new MockTarget();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        ExecutionLib.Execution memory item =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (3)));
        bytes memory accountCall = abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(item)));
        bytes32 permissionId = keccak256("permission");
        SessionKeyValidator.Permission memory permission =
            SessionKeyValidator.Permission(signer, 0, type(uint48).max, keccak256(accountCall), 2, address(0));
        bytes memory grant = abi.encodeCall(SessionKeyValidator.grantPermission, (permissionId, permission));
        ExecutionLib.Execution memory directGrant = ExecutionLib.Execution(address(validator), 0, grant);
        (bool immediate,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(directGrant))));
        require(!immediate, "session permission bypassed config timelock");

        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, grant);
        require(account.configVersion() == 2, "session permission did not advance config");

        bytes32 userOpHash = keccak256("user-op");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, userOpHash);
        bytes memory validatorSignature = abi.encode(permissionId, abi.encodePacked(r, s, v), keccak256(accountCall));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 nonceKey = uint256(uint192(bytes24(permissionId))) << 64;

        require(
            validator.validateUserOp(
                    address(account), userOpHash, nonceKey, validatorSignature, accountCall, address(0)
                ) != ValidationDataLib.SIG_VALIDATION_FAILED,
            "valid permission rejected"
        );
        require(
            validator.validateUserOp(
                    address(account), userOpHash, nonceKey, validatorSignature, accountCall, address(1)
                ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "unapproved paymaster accepted"
        );
        require(
            validator.validateUserOp(
                address(account), userOpHash, nonceKey + 2, validatorSignature, accountCall, address(0)
            ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "use limit bypassed"
        );
        require(
            validator.validateUserOp(
                address(account), userOpHash, nonceKey, validatorSignature, bytes("altered"), address(0)
            ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "altered call accepted"
        );

        account.execute(
            bytes32(0),
            abi.encode(
                ExecutionLib.Execution(
                    address(validator), 0, abi.encodeCall(SessionKeyValidator.revokePermission, (permissionId))
                )
            )
        );
        require(
            validator.validateUserOp(
                    address(account), userOpHash, nonceKey, validatorSignature, accountCall, address(0)
                ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "revoked permission accepted"
        );
    }

    function testZeroPermissionIdRejected() public {
        SessionKeyValidator validator = new SessionKeyValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        SessionKeyValidator.Permission memory permission =
            SessionKeyValidator.Permission(address(1), 0, type(uint48).max, keccak256("call"), 1, address(0));
        bytes memory grant = abi.encodeCall(SessionKeyValidator.grantPermission, (bytes32(0), permission));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(validator), 0, grant)));
        require(!ok, "zero permission id accepted");
    }
}

contract ECDSAValidatorTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testPrimaryECDSARequiresInstalledPolicyHookAndValidSignature() public {
        uint256 ownerKey = 0xA11CE;
        ECDSAValidator validator = new ECDSAValidator();
        MockPolicyHook hook = new MockPolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(ownerKey), address(hook)))
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
        bytes32 userOpHash = keccak256("user-op");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, userOpHash);

        require(
            validator.validateUserOp(
                    address(account), userOpHash, 0, abi.encodePacked(r, s, v), bytes("call"), address(0)
                ) == 0,
            "valid primary signature rejected"
        );
        require(
            validator.validateUserOp(
                address(account), keccak256("other"), 0, abi.encodePacked(r, s, v), bytes("call"), address(0)
            ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "invalid primary signature accepted"
        );
    }

    function testOwnerRotationRequiresConfigTimelockAndRevokesOldOwner() public {
        uint256 oldOwnerKey = 0xA11CE;
        uint256 newOwnerKey = 0xB0B;
        ECDSAValidator validator = new ECDSAValidator();
        MockPolicyHook hook = new MockPolicyHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(oldOwnerKey), address(hook)))
        );
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        bytes memory setOwner = abi.encodeCall(ECDSAValidator.setOwner, (vm.addr(newOwnerKey)));
        (bool immediate,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(validator), 0, setOwner)))
                )
            );
        require(!immediate, "owner rotation bypassed timelock");

        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, setOwner, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, setOwner);
        require(validator.owners(address(account)) == vm.addr(newOwnerKey), "owner did not rotate");
        require(account.configVersion() == 2, "owner rotation did not advance config");

        bytes32 userOpHash = keccak256("rotated-user-op");
        (uint8 oldV, bytes32 oldR, bytes32 oldS) = vm.sign(oldOwnerKey, userOpHash);
        (uint8 newV, bytes32 newR, bytes32 newS) = vm.sign(newOwnerKey, userOpHash);
        require(
            validator.validateUserOp(
                address(account), userOpHash, 0, abi.encodePacked(oldR, oldS, oldV), bytes("call"), address(0)
            ) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "old owner retained authority"
        );
        require(
            validator.validateUserOp(
                address(account), userOpHash, 0, abi.encodePacked(newR, newS, newV), bytes("call"), address(0)
            ) == 0,
            "new owner rejected"
        );
    }
}
