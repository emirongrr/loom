// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {MockTarget} from "../mocks/MockTarget.sol";

interface VmECDSAPaymasterAccounting {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function expectRevert(bytes calldata revertData) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
}

contract AdversarialPaymaster is IPaymaster {
    error OnlyEntryPoint();
    error ForcedPostOpRevert();
    error InvalidContext();

    IEntryPoint public immutable entryPoint;
    bool public immutable revertPostOperation;
    uint256 public validationCalls;
    uint256 public postOpCalls;
    PostOpMode public lastPostOpMode;

    constructor(IEntryPoint entryPoint_, bool revertPostOperation_) {
        entryPoint = entryPoint_;
        revertPostOperation = revertPostOperation_;
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        ++validationCalls;
        return (abi.encode(address(this)), 0);
    }

    function postOp(PostOpMode mode, bytes calldata context, uint256, uint256) external {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        if (abi.decode(context, (address)) != address(this)) revert InvalidContext();
        if (revertPostOperation) revert ForcedPostOpRevert();
        ++postOpCalls;
        lastPostOpMode = mode;
    }
}

contract EntryPointECDSAPaymasterAccountingTest {
    VmECDSAPaymasterAccounting internal constant vm =
        VmECDSAPaymasterAccounting(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    address payable internal constant BENEFICIARY = payable(address(0xBEEF));

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

    function testPaymasterDepositSponsorsOperationAndPaysBeneficiary() public {
        uint256 initialDeposit = 1 ether;
        AdversarialPaymaster paymaster = _paymasterWithDeposit(false, initialDeposit);
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("paymaster-sponsored-success"));
        PackedUserOperation memory op = _signedSponsoredOperation(sender, initCode, paymaster, 71);

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        _handleOp(op);

        uint256 beneficiaryPayment = BENEFICIARY.balance - beneficiaryBefore;
        uint256 remainingDeposit = entryPoint.balanceOf(address(paymaster));
        require(sender.code.length != 0, "sponsored operation did not deploy account");
        require(validator.owners(sender) == vm.addr(OWNER_KEY), "sponsored account owner initialization drifted");
        require(target.value() == 71, "sponsored target execution missing");
        require(entryPoint.getNonce(sender, 0) == 1, "sponsored operation nonce missing");
        require(paymaster.validationCalls() == 1, "paymaster validation missing");
        require(paymaster.postOpCalls() == 1, "paymaster postOp missing");
        require(paymaster.lastPostOpMode() == IPaymaster.PostOpMode.opSucceeded, "paymaster received wrong postOp mode");
        require(beneficiaryPayment != 0, "sponsored operation paid no beneficiary fee");
        require(
            remainingDeposit + beneficiaryPayment == initialDeposit,
            "paymaster deposit and beneficiary accounting did not conserve funds"
        );
        require(address(entryPoint).balance == remainingDeposit, "EntryPoint retained unaccounted sponsor funds");
    }

    function testInsufficientPaymasterDepositRevertsAllValidationState() public {
        AdversarialPaymaster paymaster = new AdversarialPaymaster(IEntryPoint(address(entryPoint)), false);
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("paymaster-deposit-too-low"));
        PackedUserOperation memory op = _signedSponsoredOperation(sender, initCode, paymaster, 81);
        uint256 beneficiaryBefore = BENEFICIARY.balance;

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA31 paymaster deposit too low"));
        _handleOp(op);

        require(sender.code.length == 0, "failed sponsorship persisted account deployment");
        require(validator.owners(sender) == address(0), "failed sponsorship persisted owner initialization");
        require(target.value() == 0, "failed sponsorship executed target call");
        require(entryPoint.getNonce(sender, 0) == 0, "failed sponsorship consumed nonce");
        require(paymaster.validationCalls() == 0, "underfunded paymaster validation executed");
        require(entryPoint.balanceOf(address(paymaster)) == 0, "failed sponsorship persisted paymaster deposit");
        require(address(entryPoint).balance == 0, "failed sponsorship left EntryPoint funds");
        require(BENEFICIARY.balance == beneficiaryBefore, "failed sponsorship paid beneficiary");
    }

    function testRevertingPostOpRollsBackExecutionButChargesPaymaster() public {
        uint256 initialDeposit = 1 ether;
        AdversarialPaymaster paymaster = _paymasterWithDeposit(true, initialDeposit);
        (address sender, bytes memory initCode) = _counterfactualAccount(keccak256("paymaster-postop-revert"));
        PackedUserOperation memory op = _signedSponsoredOperation(sender, initCode, paymaster, 91);

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        _handleOp(op);

        uint256 beneficiaryPayment = BENEFICIARY.balance - beneficiaryBefore;
        uint256 remainingDeposit = entryPoint.balanceOf(address(paymaster));
        require(sender.code.length != 0, "postOp failure rolled back validation deployment");
        require(validator.owners(sender) == vm.addr(OWNER_KEY), "postOp failure rolled back owner initialization");
        require(target.value() == 0, "postOp failure did not roll back account execution");
        require(entryPoint.getNonce(sender, 0) == 1, "postOp failure did not consume validated nonce");
        require(paymaster.validationCalls() == 1, "postOp failure lost paymaster validation");
        require(paymaster.postOpCalls() == 0, "reverting postOp persisted state");
        require(beneficiaryPayment != 0, "postOp failure paid no beneficiary fee");
        require(
            remainingDeposit + beneficiaryPayment == initialDeposit,
            "postOp failure sponsor accounting did not conserve funds"
        );
        require(address(entryPoint).balance == remainingDeposit, "EntryPoint retained failed postOp funds");
    }

    function _paymasterWithDeposit(bool revertPostOperation, uint256 depositAmount)
        internal
        returns (AdversarialPaymaster paymaster)
    {
        paymaster = new AdversarialPaymaster(IEntryPoint(address(entryPoint)), revertPostOperation);
        vm.deal(address(this), depositAmount);
        paymaster.deposit{value: depositAmount}();
    }

    function _counterfactualAccount(bytes32 salt) internal returns (address sender, bytes memory initCode) {
        LoomAccount.ModuleInit[] memory modules = _modules(vm.addr(OWNER_KEY));
        bytes32 guardianRoot = keccak256(abi.encode("guardians", salt));
        bytes32 configHash = keccak256(abi.encode("config", salt));
        sender = factory.getAddress(salt, guardianRoot, 1, configHash, modules);
        bytes memory factoryCall =
            abi.encodeCall(LoomAccountFactory.createAccount, (salt, guardianRoot, 1, configHash, modules));
        initCode = abi.encodePacked(address(factory), factoryCall);
    }

    function _signedSponsoredOperation(
        address sender,
        bytes memory initCode,
        AdversarialPaymaster paymaster,
        uint256 value
    ) internal returns (PackedUserOperation memory op) {
        ExecutionLib.Execution memory execution = ExecutionLib.Execution(
            address(target), 0, abi.encodeCall(MockTarget.setValue, (value))
        );
        op = PackedUserOperation({
            sender: sender,
            nonce: entryPoint.getNonce(sender, 0),
            initCode: initCode,
            callData: abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(execution))),
            accountGasLimits: bytes32((uint256(10_000_000) << 128) | uint256(2_000_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: abi.encodePacked(address(paymaster), uint128(1_000_000), uint128(1_000_000)),
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
