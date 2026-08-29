// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {OnboardingPaymaster} from "../../src/OnboardingPaymaster.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";

interface VmOnboardingPaymaster {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert() external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract OnboardingPaymasterTest {
    VmOnboardingPaymaster private constant vm =
        VmOnboardingPaymaster(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant AUTHORIZER_KEY = 0xB0B;
    bytes32 private constant POLICY_HASH = keccak256("loom-test-onboarding-v1");
    uint256 private constant MAXIMUM_COST = 2 ether;

    EntryPoint private entryPoint;
    LoomAccountFactory private factory;
    OnboardingPaymaster private paymaster;
    ECDSAValidator private validator;
    PolicyHook private hook;

    function setUp() public {
        entryPoint = new EntryPoint();
        validator = new ECDSAValidator();
        hook = new PolicyHook();
        LoomAccount.ModuleInit[] memory implementationModules = _modules(vm.addr(OWNER_KEY));
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
        paymaster = new OnboardingPaymaster(
            IEntryPoint(address(entryPoint)), address(factory), vm.addr(AUTHORIZER_KEY), POLICY_HASH, MAXIMUM_COST
        );
        vm.deal(address(this), 10 ether);
        paymaster.deposit{value: 5 ether}();
    }

    function testAuthorizedActivationIsPaidAtomicallyByPaymaster() public {
        (address account, PackedUserOperation memory op) = _authorizedActivation(keccak256("sponsored"));
        uint256 beforeDeposit = entryPoint.balanceOf(address(paymaster));
        _handle(op);
        require(account.code.length != 0, "account was not activated");
        require(entryPoint.balanceOf(account) == 0, "sponsor value leaked into account deposit");
        require(entryPoint.balanceOf(address(paymaster)) < beforeDeposit, "paymaster was not charged");
    }

    function testInvalidAuthorizationCannotSpendPaymasterDeposit() public {
        (address account, PackedUserOperation memory op) = _authorizedActivation(keccak256("invalid"));
        uint256 beforeDeposit = entryPoint.balanceOf(address(paymaster));
        bytes memory bad = new bytes(65);
        op.paymasterAndData = _paymasterAndData(op, bad);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, entryPoint.getUserOpHash(op));
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
        vm.expectRevert();
        _handle(op);
        require(entryPoint.balanceOf(address(paymaster)) == beforeDeposit, "invalid authorization spent deposit");
        require(account.code.length == 0, "invalid authorization deployed account");
    }

    function _authorizedActivation(bytes32 accountHandle)
        private
        returns (address account, PackedUserOperation memory op)
    {
        address owner = vm.addr(OWNER_KEY);
        LoomAccount.ModuleInit[] memory modules = _modules(owner);
        bytes32 configHash = keccak256(abi.encode("config", accountHandle));
        account = factory.getAddress(accountHandle, bytes32(0), 0, configHash, modules);
        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (accountHandle, bytes32(0), 0, configHash, modules));
        op = PackedUserOperation({
            sender: account,
            nonce: 0,
            initCode: abi.encodePacked(address(factory), factoryCall),
            callData: "",
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        op.paymasterAndData = _paymasterAndData(op, "");
        bytes32 authorization = paymaster.authorizationHash(op, uint48(block.timestamp + 5 minutes), 0, MAXIMUM_COST);
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(AUTHORIZER_KEY, authorization);
        op.paymasterAndData = _paymasterAndData(op, abi.encodePacked(ar, as_, av));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, entryPoint.getUserOpHash(op));
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _paymasterAndData(PackedUserOperation memory, bytes memory authorizationSignature)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            address(paymaster),
            bytes16(uint128(150_000)),
            bytes16(uint128(1)),
            abi.encode(
                uint48(block.timestamp + 5 minutes), uint48(0), MAXIMUM_COST, POLICY_HASH, authorizationSignature
            )
        );
    }

    function _handle(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        address bundler = address(0xCAFE);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
        vm.stopPrank();
    }

    function _modules(address owner) private view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
    }

    receive() external payable {}
}
