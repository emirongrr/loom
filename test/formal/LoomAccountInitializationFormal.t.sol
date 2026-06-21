// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {LoomAccountProxy} from "../../src/proxy/LoomAccountProxy.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {FormalAccountBase, FormalTarget} from "./FormalHelpers.sol";

contract LoomAccountInitializationFormal is FormalAccountBase {
    function test_InitializedAccountCannotBeReinitialized() public {
        check_InitializedAccountCannotBeReinitialized();
    }

    function check_InitializedAccountCannotBeReinitialized() public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        bytes32 guardianRootBefore = account.guardianRoot();
        uint8 guardianThresholdBefore = account.guardianThreshold();
        bytes32 configHashBefore = account.configHash();
        uint64 configVersionBefore = account.configVersion();

        (bool ok,) = address(account)
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
        assert(account.guardianRoot() == guardianRootBefore);
        assert(account.guardianThreshold() == guardianThresholdBefore);
        assert(account.configHash() == configHashBefore);
        assert(account.configVersion() == configVersionBefore);
        assert(account.validatorCount() == 1);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)));
        assert(!account.isModuleInstalled(ModuleType.VALIDATOR, address(newValidator)));
    }

    function test_DelegatedInitializerRejectsExternalCaller() public {
        check_DelegatedInitializerRejectsExternalCaller();
    }

    function check_DelegatedInitializerRejectsExternalCaller() public {
        (LoomAccount account, MockValidator validator) = _account();
        MockValidator newValidator = new MockValidator();
        bytes32 configHashBefore = account.configHash();
        uint64 configVersionBefore = account.configVersion();

        (bool ok,) = address(account)
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
        assert(account.configHash() == configHashBefore);
        assert(account.configVersion() == configVersionBefore);
        assert(account.validatorCount() == 1);
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

        (bool upgradeOk,) = address(proxy).call(abi.encodeWithSignature("upgradeTo(address)", address(this)));
        (bool changeOk,) = address(proxy).call(abi.encodeWithSignature("changeImplementation(address)", address(this)));
        (bool adminOk,) = address(proxy).call(abi.encodeWithSignature("admin()"));

        assert(!upgradeOk);
        assert(!changeOk);
        assert(!adminOk);
        assert(proxy.implementation() == implementationBefore);
    }

    function testFuzz_InvalidDirectExecutionDoesNotConsumeNonce(uint48 validUntil, bytes calldata signature) public {
        check_InvalidDirectExecutionDoesNotConsumeNonce(validUntil, signature);
    }

    function check_InvalidDirectExecutionDoesNotConsumeNonce(uint48 validUntil, bytes calldata signature) public {
        (LoomAccount account,) = _account();
        MockValidator uninstalledValidator = new MockValidator();
        FormalTarget target = new FormalTarget();
        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(FormalTarget.setValue, (1))));
        uint256 nonceBefore = account.directExecutionNonces(address(uninstalledValidator));

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (address(uninstalledValidator), bytes32(0), executionCalldata, validUntil, signature)
                )
            );

        assert(!ok);
        assert(account.directExecutionNonces(address(uninstalledValidator)) == nonceBefore);
        assert(target.value() == 0);
    }
}
