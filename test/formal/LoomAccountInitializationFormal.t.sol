// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountProxy} from "../../src/LoomAccountProxy.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountInitializationFormal is FormalAccountBase {
    struct AccountSnapshot {
        address entryPoint;
        address validator;
        bytes32 configHash;
        bytes32 guardianRoot;
        uint256 validatorCount;
        uint256 validatorNonce;
        uint64 configVersion;
        uint48 frozenUntil;
        uint8 guardianThreshold;
        bool executingScheduled;
    }

    function _accountSnapshot(LoomAccount account) internal view returns (AccountSnapshot memory snapshot) {
        snapshot.entryPoint = account.entryPoint();
        snapshot.validatorCount = account.validatorCount();
        snapshot.validator = snapshot.validatorCount == 0 ? address(0) : account.validatorAt(0);
        snapshot.configHash = account.configHash();
        snapshot.guardianRoot = account.guardianRoot();
        snapshot.validatorNonce = account.directExecutionNonces(snapshot.validator);
        snapshot.configVersion = account.configVersion();
        snapshot.frozenUntil = account.frozenUntil();
        snapshot.guardianThreshold = account.guardianThreshold();
        snapshot.executingScheduled = account.isExecutingScheduled();
    }

    function _assertAccountUnchanged(LoomAccount account, AccountSnapshot memory expected) internal view {
        assert(account.entryPoint() == expected.entryPoint);
        assert(account.validatorCount() == expected.validatorCount);
        if (expected.validatorCount != 0) {
            assert(account.validatorAt(0) == expected.validator);
            assert(account.isModuleInstalled(ModuleType.VALIDATOR, expected.validator));
            assert(account.directExecutionNonces(expected.validator) == expected.validatorNonce);
        }
        assert(account.configHash() == expected.configHash);
        assert(account.guardianRoot() == expected.guardianRoot);
        assert(account.configVersion() == expected.configVersion);
        assert(account.frozenUntil() == expected.frozenUntil);
        assert(account.guardianThreshold() == expected.guardianThreshold);
        assert(account.isExecutingScheduled() == expected.executingScheduled);
    }

    function _assertRevert(bytes memory revertData, bytes4 expectedSelector) internal pure {
        assert(keccak256(revertData) == keccak256(abi.encodeWithSelector(expectedSelector)));
    }

    function test_InitializedAccountCannotBeReinitialized() public {
        check_InitializedAccountCannotBeReinitialized();
    }

    /// @notice One-shot initialization: an account that already holds a
    /// configuration rejects re-initialization even when the account itself asks.
    /// @dev Uses `initializeDelegatedAccount` under a self-prank because that is the
    /// only initializer an initialized account can still reach: `initialize` is
    /// rejected earlier by the initialization-context guard, which would mask the
    /// `configVersion != 0` check this property is about. The two guards are
    /// asserted separately so each failure keeps exact provenance.
    function check_InitializedAccountCannotBeReinitialized() public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        AccountSnapshot memory beforeState = _accountSnapshot(account);

        vm.prank(address(account));
        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initializeDelegatedAccount,
                    (
                        address(this),
                        keccak256("replacement-guardians"),
                        uint8(1),
                        keccak256("replacement-config"),
                        _validatorModules(newValidator)
                    )
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidInitialization.selector);
        _assertAccountUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_LiveAccountRejectsProxyInitializer() public {
        check_LiveAccountRejectsProxyInitializer();
    }

    /// @notice `initialize` exists only for the immutable-proxy constructor, so an
    /// account that already has code must reject it regardless of configuration.
    function check_LiveAccountRejectsProxyInitializer() public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        AccountSnapshot memory beforeState = _accountSnapshot(account);

        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initialize,
                    (
                        address(this),
                        keccak256("replacement-guardians"),
                        uint8(1),
                        keccak256("replacement-config"),
                        _validatorModules(newValidator)
                    )
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidInitializationContext.selector);
        _assertAccountUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_UninitializedDelegatedAccountRejectsProxyInitializer() public {
        check_UninitializedDelegatedAccountRejectsProxyInitializer();
    }

    /// @notice The account-takeover property, stated over the state that made the
    /// takeover possible: Loom runtime code present, Loom storage still empty.
    /// @dev `initializedAccountCannotBeReinitialized` and its Certora counterpart
    /// both assumed `configVersion != 0`, so neither could observe this state. An
    /// EIP-7702 delegated EOA reaches it as soon as the delegation is installed, and
    /// before the initialization-context guard any third party could configure it.
    /// Etching the runtime models the delegation's effect exactly: `address(this)`
    /// differs from the template's own `_self`, and storage reads as all zero.
    function check_UninitializedDelegatedAccountRejectsProxyInitializer() public {
        (LoomAccount template, MockValidator templateValidator) = _account();
        address delegated = address(0xD31E6A7E);
        vm.etch(delegated, address(template).code);
        LoomAccount account = LoomAccount(payable(delegated));
        assert(account.configVersion() == 0);

        MockValidator attackerValidator = new MockValidator();
        (bool ok, bytes memory revertData) = delegated.call(
            abi.encodeCall(
                LoomAccount.initialize,
                (
                    address(this),
                    keccak256("attacker-guardians"),
                    uint8(1),
                    keccak256("attacker-config"),
                    _validatorModules(attackerValidator)
                )
            )
        );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidInitializationContext.selector);
        assert(account.configVersion() == 0);
        assert(account.configHash() == bytes32(0));
        assert(account.entryPoint() == address(0));
        assert(account.guardianRoot() == bytes32(0));
        assert(account.guardianThreshold() == 0);
        assert(account.validatorCount() == 0);
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(attackerValidator)));
        // The template the delegation points at is untouched.
        assert(template.configVersion() == 1);
        assert(template.isModuleInstalled(ModuleType.VALIDATOR, address(templateValidator)));
        assert(!template.isModuleInstalled(ModuleType.VALIDATOR, address(attackerValidator)));
    }

    function test_DelegatedInitializerRejectsExternalCaller() public {
        check_DelegatedInitializerRejectsExternalCaller();
    }

    function check_DelegatedInitializerRejectsExternalCaller() public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        AccountSnapshot memory beforeState = _accountSnapshot(account);

        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initializeDelegatedAccount,
                    (
                        address(this),
                        keccak256("delegated-guardians"),
                        uint8(1),
                        keccak256("delegated-config"),
                        _validatorModules(newValidator)
                    )
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidInitialization.selector);
        _assertAccountUnchanged(account, beforeState);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_ImmutableProxyInitializesProxyStorage() public {
        check_ImmutableProxyInitializesProxyStorage();
    }

    function check_ImmutableProxyInitializesProxyStorage() public {
        address entryPoint = _entryPointAddress();
        MockValidator implementationValidator = new MockValidator();
        LoomAccount implementation = new LoomAccount(
            entryPoint,
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            _validatorModules(implementationValidator)
        );
        MockValidator proxyValidator = new MockValidator();
        bytes memory initData = abi.encodeCall(
            LoomAccount.initialize,
            (
                entryPoint,
                keccak256("proxy-guardians"),
                uint8(1),
                keccak256("proxy-config"),
                _validatorModules(proxyValidator)
            )
        );

        LoomAccountProxy proxy = new LoomAccountProxy(address(implementation), initData);
        LoomAccount account = LoomAccount(payable(address(proxy)));

        assert(proxy.implementation() == address(implementation));
        assert(account.configHash() == keccak256("proxy-config"));
        assert(account.configVersion() == 1);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(proxyValidator)));
        assert(!implementation.isModuleInstalled(ModuleType.VALIDATOR, address(proxyValidator)));
        assert(implementation.isModuleInstalled(ModuleType.VALIDATOR, address(implementationValidator)));
    }

    function test_NoMutableUpgradeSelectorsThroughProxy() public {
        check_NoMutableUpgradeSelectorsThroughProxy();
    }

    function check_NoMutableUpgradeSelectorsThroughProxy() public {
        address entryPoint = _entryPointAddress();
        MockValidator implementationValidator = new MockValidator();
        LoomAccount implementation = new LoomAccount(
            entryPoint,
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            _validatorModules(implementationValidator)
        );
        MockValidator proxyValidator = new MockValidator();
        LoomAccountProxy proxy = new LoomAccountProxy(
            address(implementation),
            abi.encodeCall(
                LoomAccount.initialize,
                (
                    entryPoint,
                    keccak256("proxy-guardians"),
                    uint8(1),
                    keccak256("proxy-config"),
                    _validatorModules(proxyValidator)
                )
            )
        );
        address implementationBefore = proxy.implementation();
        LoomAccount proxyAccount = LoomAccount(payable(address(proxy)));
        AccountSnapshot memory accountBefore = _accountSnapshot(proxyAccount);

        (bool upgradeOk, bytes memory upgradeRevertData) =
            address(proxy).call(abi.encodeWithSignature("upgradeTo(address)", address(this)));
        (bool changeOk, bytes memory changeRevertData) =
            address(proxy).call(abi.encodeWithSignature("changeImplementation(address)", address(this)));
        (bool adminOk, bytes memory adminRevertData) = address(proxy).call(abi.encodeWithSignature("admin()"));

        assert(!upgradeOk);
        assert(upgradeRevertData.length == 0);
        assert(!changeOk);
        assert(changeRevertData.length == 0);
        assert(!adminOk);
        assert(adminRevertData.length == 0);
        assert(proxy.implementation() == implementationBefore);
        _assertAccountUnchanged(proxyAccount, accountBefore);
    }

    function testFuzz_InvalidDirectExecutionDoesNotConsumeNonce(uint48 validUntil, bytes calldata signature) public {
        check_InvalidDirectExecutionDoesNotConsumeNonce(validUntil, signature);
    }

    function check_InvalidDirectExecutionDoesNotConsumeNonce(uint48 validUntil, bytes calldata signature) public {
        (LoomAccount account,) = _account();
        AccountSnapshot memory beforeState = _accountSnapshot(account);
        MockValidator uninstalledValidator = new MockValidator();
        FormalTarget target = new FormalTarget();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (1))));
        uint256 nonceBefore = account.directExecutionNonces(address(uninstalledValidator));

        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (address(uninstalledValidator), bytes32(0), executionCalldata, validUntil, signature)
                )
            );

        assert(!ok);
        _assertRevert(revertData, LoomAccount.InvalidDirectExecution.selector);
        _assertAccountUnchanged(account, beforeState);
        assert(account.directExecutionNonces(address(uninstalledValidator)) == nonceBefore);
        assert(target.value() == 0);
    }
}
