// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {AppAccountRegistry} from "../../src/AppAccountRegistry.sol";
import {LoomAccountProxy} from "../../src/LoomAccountProxy.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {InitializerReentrantModule} from "../mocks/InitializerReentrantModule.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

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

        (bool reinitialized, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initialize,
                    (address(entryPoint), keccak256("new-guardians"), 1, keccak256("new-config"), modules)
                )
            );
        require(!reinitialized, "proxy reinitialized");
        // A deployed proxy has code, so the bootstrap initializer is rejected by the
        // initialization-context guard before the one-shot check is reached. Assert
        // the exact error so this cannot pass for an unrelated reason.
        require(
            keccak256(revertData)
                == keccak256(abi.encodeWithSelector(LoomAccount.InvalidInitializationContext.selector)),
            "wrong reinitialization rejection"
        );
        require(account.configHash() == keccak256("config"), "rejected reinitialization changed config hash");
        require(account.configVersion() == 1, "rejected reinitialization changed config version");

        (bool upgraded,) = address(account).call(abi.encodeWithSignature("upgradeTo(address)", address(0xBEEF)));
        require(!upgraded, "upgrade selector accepted");
        require(
            LoomAccountProxy(payable(address(account))).implementation() == address(implementation),
            "implementation changed"
        );

        (bool admin,) = address(account).call(abi.encodeWithSignature("admin()"));
        require(!admin, "admin selector accepted");
    }

    /// @notice The constructor window the initialization-context guard allows is
    /// unreachable by an external call.
    /// @dev `initialize` permits exactly one context: an account whose code length is
    /// still zero, which means a constructor. `_initialize` installs modules by
    /// calling into them, so a malicious module gets to run inside that window and is
    /// the strongest position an attacker can occupy. It gains nothing: an account
    /// under construction has no code, so the call dispatches no runtime, returns
    /// success with empty returndata, and changes nothing. Only the proxy
    /// constructor's own delegatecall executes the runtime in that context, and it is
    /// atomic with deployment. This is why the guard needs no companion check on the
    /// runtime's own address.
    function testExternalCallCannotReachTheConstructorInitializationWindow() public {
        InitializerReentrantModule reentrant = new InitializerReentrantModule();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(reentrant), abi.encodeCall(InitializerReentrantModule.initialize, ())
        );

        LoomAccount account =
            new LoomAccount(address(entryPoint), keccak256("guardians"), 1, keccak256("reentry-config"), modules);

        require(reentrant.reentryAttempted(), "reentrancy was never attempted");
        // The account had no code while the module ran, which is exactly the state the
        // guard allows -- and exactly the state that makes the call a no-op.
        require(reentrant.accountCodeSizeDuringInstall() == 0, "account had code during construction");
        require(reentrant.reentryCallSucceeded(), "call to a codeless address should report success");
        require(reentrant.reentryReturnData().length == 0, "no runtime should have executed");
        require(account.configVersion() == 1, "reentrancy changed config version");
        require(account.configHash() == keccak256("reentry-config"), "reentrancy changed config hash");
        require(account.guardianRoot() == keccak256("guardians"), "reentrancy changed guardian root");
        require(account.validatorCount() == 1, "reentrancy changed validator count");
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
        bytes32 accountHandle = keccak256("registry-account");
        registry.registerAccount(accountHandle, address(accountLike));
        require(registry.isAccount(address(accountLike)), "account not registered");
        require(registry.accountForHandle(accountHandle) == address(accountLike), "account handle not registered");
        require(registry.handleForAccount(address(accountLike)) == accountHandle, "reverse account handle missing");
        require(registry.accountCount() == 1, "count missing");

        MockTarget zeroIdAccount = new MockTarget();
        try registry.registerAccount(bytes32(0), address(zeroIdAccount)) {
            revert("zero wallet id accepted");
        } catch {}
        require(!registry.isAccount(address(zeroIdAccount)), "zero wallet id registered account");
        require(registry.handleForAccount(address(zeroIdAccount)) == bytes32(0), "zero handle left reverse binding");

        try registry.registerAccount(accountHandle, address(accountLike)) {
            revert("duplicate registration accepted");
        } catch {}
        require(registry.accountCount() == 1, "duplicate inflated count");

        bytes32 secondAccountHandle = keccak256("second-registry-account");
        try registry.registerAccount(secondAccountHandle, address(accountLike)) {
            revert("account accepted a second wallet id");
        } catch {}
        require(registry.accountForHandle(secondAccountHandle) == address(0), "failed registration left forward binding");
        require(registry.handleForAccount(address(accountLike)) == accountHandle, "failed registration changed handle");
        require(registry.accountCount() == 1, "second wallet id inflated count");

        AppAccountRegistry factoryRegistry = factory.registry();
        try factoryRegistry.registerAccount(keccak256("foreign-wallet"), address(accountLike)) {
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
