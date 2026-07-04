// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";

import {LoomAccount} from "../../src/LoomAccount.sol";
import {VaultHook} from "../../src/hooks/VaultHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FormalAccountBase, FormalGuardianVerifier} from "./FormalHelpers.sol";

contract LoomVaultHookFormal is FormalAccountBase {
    function testFuzz_VaultWithdrawalDelayIsEnforced(uint256 amount) public {
        check_VaultWithdrawalDelayIsEnforced(amount);
    }

    function check_VaultWithdrawalDelayIsEnforced(uint256 amount) public {
        amount = (amount % 1000) + 11;
        (LoomAccount account, VaultHook vault, MockERC20 token) = _accountWithVault();
        token.mint(address(account), amount);
        _setVaultPolicy(account, vault, address(token));

        bytes memory transferCall = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), amount));
        bytes memory scheduleWithdrawal =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(token), 0, transferCall, 1 days));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(vault), 0, scheduleWithdrawal));

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, transferCall)))
                )
            );

        assert(!ok);
        assert(token.balanceOf(address(0xCAFE)) == 0);
    }

    function testFuzz_VaultGuardianCancellationGrantsNoSpendingAuthority(uint256 amount) public {
        check_VaultGuardianCancellationGrantsNoSpendingAuthority(amount);
    }

    function check_VaultGuardianCancellationGrantsNoSpendingAuthority(uint256 amount) public {
        amount = (amount % 1000) + 11;
        FormalGuardianVerifier verifier = new FormalGuardianVerifier();
        bytes32 keyCommitment = keccak256("key");
        bytes32 salt = keccak256("salt");
        bytes32 leaf = _guardianLeaf(verifier, keyCommitment, salt);

        MockValidator validator = new MockValidator();
        VaultHook vault = new VaultHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vault), "");
        LoomAccount account = new LoomAccount(_entryPointAddress(), leaf, 1, keccak256("config"), modules);

        MockERC20 token = new MockERC20();
        token.mint(address(account), amount);
        _setVaultPolicy(account, vault, address(token));

        bytes memory transferCall = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), amount));
        bytes memory scheduleWithdrawal =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(token), 0, transferCall, 1 days));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(vault), 0, scheduleWithdrawal));

        bytes32 withdrawalId = vault.withdrawalIdFor(
            address(account), address(token), 0, keccak256(transferCall), account.configVersion()
        );
        GuardianVerificationLib.Approval[] memory approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval(address(verifier), keyCommitment, salt, "", new bytes32[](0));

        vault.cancelVaultWithdrawalWithGuardians(address(account), withdrawalId, approvals);

        (uint48 readyAt,,) = vault.pendingWithdrawals(address(account), withdrawalId);
        assert(readyAt == 0);

        vm.warp(block.timestamp + 1 days);
        (bool executed,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (bytes32(0), abi.encode(ExecutionLib.Execution(address(token), 0, transferCall)))
                )
            );
        assert(!executed);
        assert(token.balanceOf(address(0xCAFE)) == 0);
    }

    function _accountWithVault() internal returns (LoomAccount account, VaultHook vault, MockERC20 token) {
        MockValidator validator = new MockValidator();
        vault = new VaultHook();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        modules[1] = LoomAccount.ModuleInit(ModuleType.HOOK, address(vault), "");
        account = new LoomAccount(_entryPointAddress(), keccak256("guardians"), 1, keccak256("config"), modules);
        token = new MockERC20();
    }

    function _setVaultPolicy(LoomAccount account, VaultHook vault, address asset) internal {
        VaultHook.VaultPolicy memory policy = VaultHook.VaultPolicy(0, 1 days, vault.MIN_VAULT_DELAY(), true);
        bytes memory setPolicy = abi.encodeCall(VaultHook.setVaultPolicy, (asset, policy));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(vault), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(account), 0, schedule));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(vault), 0, setPolicy);
    }
}
