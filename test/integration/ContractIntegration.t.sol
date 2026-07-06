// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {GranularSessionValidator} from "../../src/validators/GranularSessionValidator.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPaymaster} from "../mocks/MockPaymaster.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

interface VmIntegration {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function deal(address account, uint256 amount) external;
}

contract ContractIntegrationTest {
    VmIntegration internal constant vm = VmIntegration(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant SESSION_KEY = 0xB0B;

    function testMultiValidatorRoutingDoesNotCrossPolluteOrBypassEachOther() public {
        ECDSAValidator ecdsa = new ECDSAValidator();
        GranularSessionValidator session = new GranularSessionValidator();
        PolicyHook hook = new PolicyHook();
        address owner = vm.addr(OWNER_KEY);
        address signer = vm.addr(SESSION_KEY);

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(ecdsa), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        modules[2] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(session), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        MockERC20 token = new MockERC20();
        token.mint(address(account), 1_000);

        bytes32 permissionId = keccak256("session-permission");
        GranularSessionValidator.Permission memory permission = GranularSessionValidator.Permission({
            signer: signer,
            target: address(token),
            token: address(token),
            counterparty: address(0xBEEF),
            allowedPaymaster: address(0),
            selector: MockERC20.transfer.selector,
            maxAmountPerCall: 60,
            maxAmountPerUserOp: 60,
            maxCallsPerUserOp: 1,
            maxUses: 5,
            validAfter: 0,
            validUntil: type(uint48).max
        });
        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission));
        bytes memory scheduleGrant =
            abi.encodeCall(LoomAccount.scheduleCall, (address(session), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleGrant)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(session), 0, grant);

        bytes32 ownerOpHash = keccak256("owner-user-op");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, ownerOpHash);
        PackedUserOperation memory ownerOp = _emptyUserOp(address(account));
        ownerOp.signature = abi.encode(address(ecdsa), abi.encodePacked(r, s, v));
        require(
            account.validateUserOp(ownerOp, ownerOpHash, 0) == 0,
            "owner signature rejected with second validator installed"
        );

        ExecutionLib.Execution memory sessionTransfer =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 60)));
        bytes memory sessionAccountCall = abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(sessionTransfer)));
        bytes32 sessionUserOpHash = keccak256("session-user-op");
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(SESSION_KEY, sessionUserOpHash);
        PackedUserOperation memory sessionOp = _emptyUserOp(address(account));
        sessionOp.callData = sessionAccountCall;
        // forge-lint: disable-next-line(unsafe-typecast)
        sessionOp.nonce = uint256(uint192(bytes24(permissionId))) << 64;
        sessionOp.signature = abi.encode(address(session), abi.encode(permissionId, abi.encodePacked(sr, ss, sv)));
        require(
            account.validateUserOp(sessionOp, sessionUserOpHash, 0) != ValidationDataLib.SIG_VALIDATION_FAILED,
            "session signature rejected with primary validator installed"
        );

        PackedUserOperation memory crossed = _emptyUserOp(address(account));
        crossed.signature = abi.encode(address(session), abi.encodePacked(r, s, v));
        require(
            account.validateUserOp(crossed, ownerOpHash, 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "owner-shaped signature accepted by the session validator's decode path"
        );

        PackedUserOperation memory reversed = _emptyUserOp(address(account));
        reversed.signature = abi.encode(address(ecdsa), abi.encode(permissionId, abi.encodePacked(sr, ss, sv)));
        require(
            account.validateUserOp(reversed, sessionUserOpHash, 0) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "session-shaped signature accepted by the owner validator's decode path"
        );
    }

    function testSessionExecutionSharesPolicyHookSpendBudgetWithOwner() public {
        ECDSAValidator ecdsa = new ECDSAValidator();
        GranularSessionValidator session = new GranularSessionValidator();
        PolicyHook hook = new PolicyHook();
        address owner = vm.addr(OWNER_KEY);
        address signer = vm.addr(SESSION_KEY);

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(ecdsa), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        modules[2] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(session), "");
        LoomAccount account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        MockERC20 token = new MockERC20();
        token.mint(address(account), 1_000);

        PolicyHook.Policy memory policy = PolicyHook.Policy(100, 100, 1 days, address(0xBEEF), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        bytes memory scheduleSetPolicy =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleSetPolicy)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);

        bytes32 permissionId = keccak256("shared-budget-permission");
        GranularSessionValidator.Permission memory permission = GranularSessionValidator.Permission({
            signer: signer,
            target: address(token),
            token: address(token),
            counterparty: address(0xBEEF),
            allowedPaymaster: address(0),
            selector: MockERC20.transfer.selector,
            maxAmountPerCall: 80,
            maxAmountPerUserOp: 80,
            maxCallsPerUserOp: 1,
            maxUses: 5,
            validAfter: 0,
            validUntil: type(uint48).max
        });
        bytes memory grant = abi.encodeCall(GranularSessionValidator.grantPermission, (permissionId, permission));
        bytes memory scheduleGrant =
            abi.encodeCall(LoomAccount.scheduleCall, (address(session), 0, grant, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, scheduleGrant)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(session), 0, grant);

        ExecutionLib.Execution memory ownerTransfer =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 60)));
        account.execute(bytes32(0), abi.encode(ownerTransfer));
        require(token.balanceOf(address(0xBEEF)) == 60, "owner transfer within policy failed");

        ExecutionLib.Execution memory sessionTransfer =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 50)));
        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(sessionTransfer))));
        require(
            !ok, "execution within the session validator's own limit bypassed the account-wide PolicyHook period budget"
        );
        require(token.balanceOf(address(0xBEEF)) == 60, "blocked execution still moved funds");
    }

    function testPaymasterSponsoredExecutionStillEnforcesPolicyLimit() public {
        EntryPoint entryPoint = new EntryPoint();
        ECDSAValidator ecdsa = new ECDSAValidator();
        PolicyHook hook = new PolicyHook();
        address owner = vm.addr(OWNER_KEY);

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(ecdsa), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        LoomAccount implementation = new LoomAccount(
            address(entryPoint), keccak256("implementation-guardians"), 1, keccak256("implementation-config"), modules
        );
        LoomAccountFactory factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));

        bytes32 salt = keccak256("paymaster-policy-integration");
        address sender = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        address senderCreator = address(entryPoint.senderCreator());
        vm.startPrank(senderCreator, senderCreator);
        factory.createAccount(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        vm.stopPrank();
        LoomAccount account = LoomAccount(payable(sender));

        MockERC20 token = new MockERC20();
        token.mint(sender, 1_000);
        vm.deal(sender, 1 ether);

        PolicyHook.Policy memory policy = PolicyHook.Policy(10, 10, 1 days, address(0xBEEF), true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (address(token), token.transfer.selector, policy));
        bytes memory scheduleSetPolicy =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        _submitOwnerOp(entryPoint, ecdsa, account, abi.encode(ExecutionLib.Execution(sender, 0, scheduleSetPolicy)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);

        MockPaymaster paymaster = new MockPaymaster(IEntryPoint(address(entryPoint)));
        paymaster.deposit{value: 1 ether}();

        ExecutionLib.Execution memory overLimit =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 15)));
        _submitSponsoredOwnerOp(entryPoint, ecdsa, account, paymaster, abi.encode(overLimit));
        require(token.balanceOf(address(0xBEEF)) == 0, "paymaster-sponsored op bypassed the per-call policy limit");

        ExecutionLib.Execution memory withinLimit =
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 10)));
        _submitSponsoredOwnerOp(entryPoint, ecdsa, account, paymaster, abi.encode(withinLimit));
        require(token.balanceOf(address(0xBEEF)) == 10, "paymaster-sponsored op within policy limit did not execute");
        require(paymaster.validations() == 2, "paymaster did not validate both sponsored ops");
    }

    function _submitOwnerOp(
        EntryPoint entryPoint,
        ECDSAValidator ecdsa,
        LoomAccount account,
        bytes memory executionData
    ) internal {
        PackedUserOperation memory op = _emptyUserOp(address(account));
        op.nonce = entryPoint.getNonce(address(account), 0);
        op.callData = abi.encodeCall(LoomAccount.execute, (bytes32(0), executionData));
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, userOpHash);
        op.signature = abi.encode(address(ecdsa), abi.encodePacked(r, s, v));

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
    }

    function _submitSponsoredOwnerOp(
        EntryPoint entryPoint,
        ECDSAValidator ecdsa,
        LoomAccount account,
        MockPaymaster paymaster,
        bytes memory executionData
    ) internal {
        PackedUserOperation memory op = _emptyUserOp(address(account));
        op.nonce = entryPoint.getNonce(address(account), 0);
        op.callData = abi.encodeCall(LoomAccount.execute, (bytes32(0), executionData));
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(1_000_000), uint128(1_000_000));
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, userOpHash);
        op.signature = abi.encode(address(ecdsa), abi.encodePacked(r, s, v));

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
    }

    function _emptyUserOp(address sender) internal pure returns (PackedUserOperation memory userOp) {
        userOp.sender = sender;
        userOp.callData = abi.encodeCall(
            LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(address(0), 0, bytes(""))))
        );
        userOp.accountGasLimits = bytes32((uint256(10_000_000) << 128) | uint256(2_000_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
    }

    receive() external payable {}
}
