// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../src/account/LoomAccount.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {ExecutionLib} from "../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockPolicyHook} from "./mocks/MockPolicyHook.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

interface Vm7702 {
    function addr(uint256 privateKey) external returns (address);
    function etch(address target, bytes calldata code) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract EIP7702IntegrationTest {
    Vm7702 internal constant vm = Vm7702(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;

    function testDelegatedAccountInitializesOnceFromSelfAndUsesLoomExecution() public {
        MockEntryPoint entryPoint = new MockEntryPoint();
        MockPolicyHook hook = new MockPolicyHook();
        ECDSAValidator validator = new ECDSAValidator();
        MockTarget target = new MockTarget();
        address delegated = vm.addr(OWNER_KEY);
        _installDelegatedCode(delegated, address(entryPoint));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(validator),
            abi.encodeCall(ECDSAValidator.initialize, (delegated, address(hook)))
        );

        require(
            _tryInitialize(address(0xB0B), delegated, address(entryPoint), modules) == false,
            "external caller initialized 7702 account"
        );
        require(_tryInitialize(delegated, delegated, address(entryPoint), modules), "self initialization failed");

        LoomAccount account = LoomAccount(payable(delegated));
        require(account.configVersion() == 1, "config version missing");
        require(account.configHash() == keccak256("7702-config"), "config hash missing");
        require(account.guardianRoot() == keccak256("guardians"), "guardian root missing");
        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "validator missing");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook missing");

        bytes memory executionCalldata =
            abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (42))));
        uint48 validUntil = type(uint48).max;
        bytes32 digest = account.directExecutionDigest(
            address(validator), account.SINGLE_EXECUTION_MODE(), executionCalldata, 0, validUntil
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        account.executeDirect(
            address(validator),
            account.SINGLE_EXECUTION_MODE(),
            executionCalldata,
            validUntil,
            abi.encodePacked(r, s, v)
        );

        require(target.value() == 42, "delegated account execution failed");
    }

    function testConstructorInitializedAccountRejectsDelegatedInitializer() public {
        MockEntryPoint entryPoint = new MockEntryPoint();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount account =
            new LoomAccount(address(entryPoint), keccak256("guardians"), 1, keccak256("config"), modules);

        vm.prank(address(account));
        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.initializeDelegatedAccount,
                    (address(entryPoint), keccak256("new-guardians"), 1, keccak256("new-config"), modules)
                )
            );

        require(!ok, "constructor account reinitialized");
        require(account.configHash() == keccak256("config"), "constructor config changed");
    }

    function _installDelegatedCode(address delegated, address entryPoint) internal {
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount template =
            new LoomAccount(entryPoint, keccak256("template-guardians"), 1, keccak256("template-config"), modules);
        vm.etch(delegated, address(template).code);
    }

    function _tryInitialize(
        address sender,
        address delegated,
        address entryPoint,
        LoomAccount.ModuleInit[] memory modules
    ) internal returns (bool ok) {
        vm.prank(sender);
        (ok,) = delegated.call(
            abi.encodeCall(
                LoomAccount.initializeDelegatedAccount,
                (entryPoint, keccak256("guardians"), 1, keccak256("7702-config"), modules)
            )
        );
    }
}
