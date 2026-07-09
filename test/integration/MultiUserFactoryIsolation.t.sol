// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {P256Validator} from "../../src/validators/P256Validator.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {OZP256Verifier} from "../mocks/OZP256Verifier.sol";

interface VmMultiUserFactoryIsolation {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MultiUserFactoryIsolationTest {
    VmMultiUserFactoryIsolation internal constant vm =
        VmMultiUserFactoryIsolation(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_A_KEY = 0xA11CE;
    uint256 internal constant OWNER_B_KEY = 0xB0B;
    bytes32 internal constant P256_X_A = bytes32(uint256(0x1111));
    bytes32 internal constant P256_Y_A = bytes32(uint256(0x2222));
    bytes32 internal constant P256_X_B = bytes32(uint256(0x3333));
    bytes32 internal constant P256_Y_B = bytes32(uint256(0x4444));

    MockEntryPoint internal entryPoint;
    PolicyHook internal hook;
    ECDSAValidator internal ecdsa;
    P256Validator internal p256;
    LoomAccountFactory internal factory;

    function setUp() public {
        entryPoint = new MockEntryPoint();
        hook = new PolicyHook();
        ecdsa = new ECDSAValidator();
        p256 = new P256Validator(address(new OZP256Verifier()));

        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "implementation")
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
    }

    function testDifferentSaltAndOwnerProduceDifferentAccounts() public {
        LoomAccount.ModuleInit[] memory modulesA = _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a");
        LoomAccount.ModuleInit[] memory modulesB = _modules(vm.addr(OWNER_B_KEY), P256_X_B, P256_Y_B, "owner-b");

        address accountA = address(_create(keccak256("salt-a"), modulesA));
        address accountB = address(_create(keccak256("salt-b"), modulesB));

        require(accountA != accountB, "different users shared account address");
        require(ecdsa.owners(accountA) == vm.addr(OWNER_A_KEY), "account A owner missing");
        require(ecdsa.owners(accountB) == vm.addr(OWNER_B_KEY), "account B owner missing");
        require(factory.registry().accountCount() == 2, "registry missed both users");
    }

    function testSameSaltDifferentOwnerInitDataProducesDifferentAccounts() public {
        bytes32 salt = keccak256("same-salt-different-owner");
        LoomAccount.ModuleInit[] memory modulesA = _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a");
        LoomAccount.ModuleInit[] memory modulesB = _modules(vm.addr(OWNER_B_KEY), P256_X_B, P256_Y_B, "owner-b");

        address predictedA = factory.getAddress(salt, bytes32(0), 0, keccak256("config"), modulesA);
        address predictedB = factory.getAddress(salt, bytes32(0), 0, keccak256("config"), modulesB);
        require(predictedA != predictedB, "owner-specific initData did not affect address");

        require(address(_create(salt, modulesA)) == predictedA, "account A deployed at wrong address");
        require(address(_create(salt, modulesB)) == predictedB, "account B deployed at wrong address");
    }

    function testSameSaltAndModulesArePredictableAndIdempotent() public {
        bytes32 salt = keccak256("same-salt-same-modules");
        LoomAccount.ModuleInit[] memory modules = _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a");
        address predicted = factory.getAddress(salt, bytes32(0), 0, keccak256("config"), modules);

        LoomAccount first = _create(salt, modules);
        LoomAccount second = _create(salt, modules);

        require(address(first) == predicted, "first deployment missed prediction");
        require(address(second) == predicted, "idempotent create changed address");
        require(factory.registry().accountCount() == 1, "duplicate create inflated registry");
    }

    function testFundedCounterfactualAddressCannotBeClaimedByDifferentOwner() public {
        bytes32 salt = keccak256("funded-counterfactual");
        LoomAccount.ModuleInit[] memory modulesA = _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a");
        LoomAccount.ModuleInit[] memory modulesB = _modules(vm.addr(OWNER_B_KEY), P256_X_B, P256_Y_B, "owner-b");
        address fundedA = factory.getAddress(salt, bytes32(0), 0, keccak256("config"), modulesA);
        address predictedB = factory.getAddress(salt, bytes32(0), 0, keccak256("config"), modulesB);

        vm.deal(fundedA, 1 ether);
        LoomAccount accountB = _create(salt, modulesB);

        require(address(accountB) == predictedB, "different owner did not deploy own address");
        require(address(accountB) != fundedA, "different owner claimed funded address");
        require(address(accountB).balance == 0, "different owner received counterfactual funds");
        require(fundedA.balance == 1 ether, "funded address was drained");

        LoomAccount accountA = _create(salt, modulesA);
        require(address(accountA) == fundedA, "original owner did not deploy funded address");
        require(address(accountA).balance == 1 ether, "funded address balance missing after owner deploy");
    }

    function testValidatorAndPolicyStateRemainAccountScoped() public {
        LoomAccount.ModuleInit[] memory modulesA = _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a");
        LoomAccount.ModuleInit[] memory modulesB = _modules(vm.addr(OWNER_B_KEY), P256_X_B, P256_Y_B, "owner-b");
        LoomAccount accountA = _create(keccak256("scoped-a"), modulesA);
        LoomAccount accountB = _create(keccak256("scoped-b"), modulesB);

        require(ecdsa.owners(address(accountA)) == vm.addr(OWNER_A_KEY), "account A ECDSA owner changed");
        require(ecdsa.owners(address(accountB)) == vm.addr(OWNER_B_KEY), "account B ECDSA owner changed");

        (bytes32 ax, bytes32 ay, bytes32 aRpIdHash, bytes32 aOriginHash) = p256.publicKeys(address(accountA));
        (bytes32 bx, bytes32 by, bytes32 bRpIdHash, bytes32 bOriginHash) = p256.publicKeys(address(accountB));
        require(ax == P256_X_A && ay == P256_Y_A, "account A P-256 key changed");
        require(bx == P256_X_B && by == P256_Y_B, "account B P-256 key changed");
        require(aRpIdHash != bRpIdHash && aOriginHash != bOriginHash, "P-256 metadata shared across users");

        MockERC20 token = new MockERC20();
        token.mint(address(accountA), 1_000);
        bytes32 policyId = hook.policyId(address(token), token.transfer.selector);
        _setPolicy(
            accountA,
            address(token),
            token.transfer.selector,
            PolicyHook.Policy(100, 100, 1 days, address(0xBEEF), true)
        );

        _executeFromEntryPoint(
            accountA,
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 40)))
        );

        (uint128 maxPerCallA,,,, bool enabledA) = hook.policies(address(accountA), policyId);
        (uint128 maxPerCallB,,,, bool enabledB) = hook.policies(address(accountB), policyId);
        (uint128 spentA,) = hook.spending(address(accountA), policyId);
        (uint128 spentB,) = hook.spending(address(accountB), policyId);

        require(enabledA && maxPerCallA == 100, "account A policy missing");
        require(!enabledB && maxPerCallB == 0, "account B inherited policy");
        require(spentA == 40, "account A spend missing");
        require(spentB == 0, "account B inherited spend");
    }

    function testAccountSignaturesDoNotValidateAcrossAccounts() public {
        LoomAccount accountA =
            _create(keccak256("signature-a"), _modules(vm.addr(OWNER_A_KEY), P256_X_A, P256_Y_A, "owner-a"));
        LoomAccount accountB =
            _create(keccak256("signature-b"), _modules(vm.addr(OWNER_B_KEY), P256_X_B, P256_Y_B, "owner-b"));

        bytes32 digest = keccak256("cross-account-signature");
        require(_validateOwnerSignature(accountA, OWNER_A_KEY, digest) == 0, "account A owner rejected");
        require(_validateOwnerSignature(accountB, OWNER_B_KEY, digest) == 0, "account B owner rejected");
        require(
            _validateOwnerSignature(accountB, OWNER_A_KEY, digest) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "account A signature worked on account B"
        );
        require(
            _validateOwnerSignature(accountA, OWNER_B_KEY, digest) == ValidationDataLib.SIG_VALIDATION_FAILED,
            "account B signature worked on account A"
        );
    }

    function _create(bytes32 salt, LoomAccount.ModuleInit[] memory modules) internal returns (LoomAccount) {
        return entryPoint.createAccount(factory, salt, bytes32(0), 0, keccak256("config"), modules);
    }

    function _modules(address owner, bytes32 p256X, bytes32 p256Y, string memory label)
        internal
        view
        returns (LoomAccount.ModuleInit[] memory modules)
    {
        modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(ecdsa), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        modules[2] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(p256),
            abi.encodeCall(
                P256Validator.initialize,
                (
                    p256X,
                    p256Y,
                    keccak256(abi.encode(label, "rp")),
                    keccak256(abi.encode(label, "origin")),
                    address(hook)
                )
            )
        );
    }

    function _setPolicy(LoomAccount account, address target, bytes4 selector, PolicyHook.Policy memory policy)
        internal
    {
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (target, selector, policy));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, schedule));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);
    }

    function _executeFromEntryPoint(LoomAccount account, ExecutionLib.Execution memory execution) internal {
        vm.prank(address(entryPoint));
        account.execute(bytes32(0), abi.encode(execution));
    }

    function _validateOwnerSignature(LoomAccount account, uint256 ownerKey, bytes32 digest) internal returns (uint256) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        PackedUserOperation memory op = _emptyUserOp(address(account));
        op.signature = abi.encode(address(ecdsa), abi.encodePacked(r, s, v));
        vm.prank(address(entryPoint));
        return account.validateUserOp(op, digest, 0);
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
