// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {AppAccountRegistry} from "../src/AppAccountRegistry.sol";
import {LoomAccountProxy} from "../src/LoomAccountProxy.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

interface VmProxyFactory {
    function deal(address account, uint256 amount) external;
    function prank(address sender) external;
}

contract ImmutableProxyFactoryTest {
    VmProxyFactory internal constant vm = VmProxyFactory(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockEntryPoint internal entryPoint;
    MockValidator internal validator;
    LoomAccount internal implementation;
    LoomAccountFactory internal factory;

    function setUp() public {
        entryPoint = new MockEntryPoint();
        validator = new MockValidator();
        implementation = _implementation(entryPoint, validator);
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));
    }

    function testProxyDeploymentInitializesAccountStateAndRegistersOnce() public {
        LoomAccount.ModuleInit[] memory modules = _modules(validator);
        bytes32 salt = keccak256("proxy-account");
        address predicted = factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules);
        LoomAccount account =
            entryPoint.createAccount(factory, salt, keccak256("guardians"), 1, keccak256("config"), modules);

        require(address(account) == predicted, "wrong proxy address");
        require(
            LoomAccountProxy(payable(address(account))).implementation() == address(implementation),
            "wrong implementation"
        );
        require(account.entryPoint() == address(entryPoint), "entrypoint missing");
        require(account.configHash() == keccak256("config"), "config missing");
        require(account.configVersion() == 1, "config version missing");
        require(account.guardianRoot() == keccak256("guardians"), "guardian root missing");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "validator missing");
        require(factory.registry().isAccount(address(account)), "registry missing account");
        require(factory.registry().accountCount() == 1, "registry count missing");

        LoomAccount sameAccount =
            entryPoint.createAccount(factory, salt, keccak256("guardians"), 1, keccak256("config"), modules);
        require(address(sameAccount) == address(account), "idempotent deployment changed address");
        require(factory.registry().accountCount() == 1, "duplicate deployment inflated count");
        require(implementation.configHash() == keccak256("implementation-config"), "implementation storage changed");
    }

    function testProxyCannotBeReinitializedOrUpgraded() public {
        LoomAccount account = _createAccount("proxy-reinit");
        LoomAccount.ModuleInit[] memory modules = _modules(validator);

        (bool reinitialized,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initialize,
                    (address(entryPoint), keccak256("new-guardians"), 1, keccak256("new-config"), modules)
                )
            );
        require(!reinitialized, "proxy reinitialized");

        (bool upgraded,) = address(account).call(abi.encodeWithSignature("upgradeTo(address)", address(0xBEEF)));
        require(!upgraded, "upgrade selector accepted");
        require(
            LoomAccountProxy(payable(address(account))).implementation() == address(implementation),
            "implementation changed"
        );

        (bool admin,) = address(account).call(abi.encodeWithSignature("admin()"));
        require(!admin, "admin selector accepted");
    }

    function testProxyBubblesExecutionRevertsAndStoresStateInProxy() public {
        LoomAccount account = _createAccount("proxy-execution");
        MockTarget target = new MockTarget();
        ExecutionLib.Execution memory execution =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (42)));
        vm.prank(address(entryPoint));
        account.execute(bytes32(0), abi.encode(execution));
        require(target.value() == 42, "proxy execution failed");
        require(implementation.configVersion() == 1, "implementation storage mutated");

        ExecutionLib.Execution memory failing =
            ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.fail, ()));
        vm.prank(address(entryPoint));
        (bool ok,) = address(account).call(abi.encodeCall(LoomAccount.execute, (bytes32(0), abi.encode(failing))));
        require(!ok, "revert did not bubble");
    }

    function testProxyConstructorRejectsUnsafeInputs() public {
        LoomAccount.ModuleInit[] memory modules = _modules(validator);
        bytes memory initData = abi.encodeCall(
            LoomAccount.initialize, (address(entryPoint), keccak256("guardians"), 1, keccak256("config"), modules)
        );

        try new LoomAccountProxy(address(0), initData) {
            revert("zero implementation accepted");
        } catch {}

        try new LoomAccountProxy(address(0xBEEF), initData) {
            revert("non-contract implementation accepted");
        } catch {}

        try new LoomAccountProxy(address(implementation), bytes("")) {
            revert("empty init accepted");
        } catch {}

        bytes memory invalidInit = abi.encodeCall(
            LoomAccount.initialize, (address(0xBEEF), keccak256("guardians"), 1, keccak256("config"), modules)
        );
        try new LoomAccountProxy(address(implementation), invalidInit) {
            revert("invalid init accepted");
        } catch {}
    }

    function testRegistryIsFactoryOnlyAndCannotInflateCount() public {
        AppAccountRegistry registry = new AppAccountRegistry(address(this));
        MockTarget accountLike = new MockTarget();
        registry.registerAccount(address(accountLike));
        require(registry.isAccount(address(accountLike)), "account not registered");
        require(registry.accountCount() == 1, "count missing");

        try registry.registerAccount(address(accountLike)) {
            revert("duplicate registration accepted");
        } catch {}
        require(registry.accountCount() == 1, "duplicate inflated count");

        AppAccountRegistry factoryRegistry = factory.registry();
        try factoryRegistry.registerAccount(address(accountLike)) {
            revert("non-factory registered account");
        } catch {}
    }

    function testProxyReceiveAcceptsEth() public {
        LoomAccount account = _createAccount("proxy-receive");
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(account).call{value: 1 ether}("");
        require(ok, "receive failed");
        require(address(account).balance == 1 ether, "eth missing");
    }

    function _createAccount(string memory label) internal returns (LoomAccount) {
        LoomAccount.ModuleInit[] memory modules = _modules(validator);
        return entryPoint.createAccount(
            factory, keccak256(bytes(label)), keccak256("guardians"), 1, keccak256("config"), modules
        );
    }

    function _implementation(MockEntryPoint accountEntryPoint, MockValidator accountValidator)
        internal
        returns (LoomAccount)
    {
        return new LoomAccount(
            address(accountEntryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            _modules(accountValidator)
        );
    }

    function _modules(MockValidator moduleValidator) internal pure returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(moduleValidator), "");
    }

    receive() external payable {}
}
