// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmECDSAGasAccounting {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract EntryPointECDSAGasAccountingTest {
    VmECDSAGasAccounting internal constant vm =
        VmECDSAGasAccounting(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    address payable internal constant BENEFICIARY = payable(address(0xBEEF));
    address payable internal constant WITHDRAW_RECIPIENT = payable(address(0xCAFE));

    EntryPoint internal entryPoint;
    ECDSAValidator internal validator;
    PolicyHook internal hook;
    LoomAccountFactory internal factory;
    MockTarget internal target;

    function setUp() public {
        entryPoint = new EntryPoint();
        validator = new ECDSAValidator();
        hook = new PolicyHook();

        LoomAccount.ModuleInit[] memory implementationModules = _modules(address(0xA11CE));
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
        target = new MockTarget();
    }

    function testCounterfactualAccountPrefundsGasAndPaysBeneficiary() public {
        uint256 initialAccountBalance = 1 ether;
        (address sender, bytes memory initCode) =
            _counterfactualAccount(keccak256("account-funded-prefund"), initialAccountBalance);
        PackedUserOperation memory op = _signedOperation(
            sender, entryPoint.getNonce(sender, 0), initCode, address(target), abi.encodeCall(MockTarget.setValue, (71))
        );

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        _handleOp(op);

        uint256 beneficiaryPayment = BENEFICIARY.balance - beneficiaryBefore;
        uint256 remainingDeposit = entryPoint.balanceOf(sender);
        require(target.value() == 71, "account-funded operation missing");
        require(entryPoint.getNonce(sender, 0) == 1, "account-funded operation nonce missing");
        require(beneficiaryPayment != 0, "beneficiary received no gas payment");
        require(remainingDeposit != 0, "unused prefund was not refunded to deposit");
        require(
            sender.balance + remainingDeposit + beneficiaryPayment == initialAccountBalance,
            "account-funded gas accounting did not conserve funds"
        );
        require(address(entryPoint).balance == remainingDeposit, "EntryPoint balance diverged from account deposit");
    }

    function testAccountWithdrawsDepositWhilePayingOperationGas() public {
        uint256 initialDeposit = 1 ether;
        uint256 withdrawAmount = 0.25 ether;
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("account-deposit-withdrawal"), 0);
        vm.deal(address(this), initialDeposit);
        entryPoint.depositTo{value: initialDeposit}(sender);

        PackedUserOperation memory op = _signedOperation(
            sender,
            entryPoint.getNonce(sender, 0),
            initCode,
            address(entryPoint),
            abi.encodeCall(IStakeManager.withdrawTo, (WITHDRAW_RECIPIENT, withdrawAmount))
        );
        uint256 beneficiaryBefore = BENEFICIARY.balance;
        uint256 recipientBefore = WITHDRAW_RECIPIENT.balance;
        _handleOp(op);

        uint256 beneficiaryPayment = BENEFICIARY.balance - beneficiaryBefore;
        uint256 remainingDeposit = entryPoint.balanceOf(sender);
        require(WITHDRAW_RECIPIENT.balance - recipientBefore == withdrawAmount, "deposit withdrawal amount drifted");
        require(beneficiaryPayment != 0, "withdrawal operation paid no gas");
        require(
            remainingDeposit + withdrawAmount + beneficiaryPayment == initialDeposit,
            "deposit withdrawal and gas accounting did not conserve funds"
        );
        require(address(entryPoint).balance == remainingDeposit, "EntryPoint retained unaccounted withdrawal funds");
        require(entryPoint.getNonce(sender, 0) == 1, "withdrawal operation nonce missing");
    }

    function testInsufficientAccountPrefundRevertsAllValidationState() public {
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("insufficient-account-prefund"), 0);
        PackedUserOperation memory op = _signedOperation(
            sender, entryPoint.getNonce(sender, 0), initCode, address(target), abi.encodeCall(MockTarget.setValue, (81))
        );
        uint256 beneficiaryBefore = BENEFICIARY.balance;

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA21 didn't pay prefund"));
        _handleOp(op);

        require(sender.code.length == 0, "failed prefund persisted account deployment");
        require(validator.owners(sender) == address(0), "failed prefund persisted owner initialization");
        require(target.value() == 0, "failed prefund executed target call");
        require(entryPoint.getNonce(sender, 0) == 0, "failed prefund consumed nonce");
        require(entryPoint.balanceOf(sender) == 0, "failed prefund persisted deposit");
        require(address(entryPoint).balance == 0, "failed prefund left EntryPoint funds");
        require(BENEFICIARY.balance == beneficiaryBefore, "failed prefund paid beneficiary");
    }

    function _counterfactualAccount(bytes32 salt, uint256 balance)
        internal
        returns (address sender, bytes memory initCode)
    {
        LoomAccount.ModuleInit[] memory modules = _modules(vm.addr(OWNER_KEY));
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        vm.deal(sender, balance);

        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (salt, guardianRoot, 1, configHash, modules));
        initCode = abi.encodePacked(address(factory), factoryCall);
    }

    function _signedOperation(
        address sender,
        uint256 nonce,
        bytes memory initCode,
        address operationTarget,
        bytes memory operationCall
    ) internal returns (PackedUserOperation memory op) {
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(operationTarget, 0, operationCall);
        op = PackedUserOperation({
            sender: sender,
            nonce: nonce,
            initCode: initCode,
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, userOpHash);
        op.signature = abi.encode(address(validator), abi.encodePacked(r, s, v));
    }

    function _modules(address owner) internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
    }

    function _handleOp(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        address bundler = address(0xB0B);
        vm.startPrank(bundler, bundler);
        entryPoint.handleOps(ops, BENEFICIARY);
        vm.stopPrank();
    }

    receive() external payable {}
}
