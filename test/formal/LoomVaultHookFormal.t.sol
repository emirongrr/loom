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
    struct VaultStateSnapshot {
        VaultHook.PendingWithdrawal pending;
        VaultHook.VaultPolicy policy;
        VaultHook.Spend spend;
        bytes32 configHash;
        address validator;
        uint256 accountBalance;
        uint256 recipientBalance;
        uint256 validatorNonce;
        uint256 validatorCount;
        uint64 configVersion;
        bool validatorInstalled;
        bool hookInstalled;
    }

    function _assertRevert(bytes memory revertData, bytes4 expectedSelector) internal pure {
        assert(keccak256(revertData) == keccak256(abi.encodeWithSelector(expectedSelector)));
    }

    function _pendingWithdrawal(VaultHook vault, LoomAccount account, bytes32 withdrawalId)
        internal
        view
        returns (VaultHook.PendingWithdrawal memory pending)
    {
        (pending.readyAt, pending.expiresAt, pending.configVersion) =
            vault.pendingWithdrawals(address(account), withdrawalId);
    }

    function _vaultPolicy(VaultHook vault, LoomAccount account, address asset)
        internal
        view
        returns (VaultHook.VaultPolicy memory policy)
    {
        (policy.dailyLimit, policy.period, policy.delay, policy.enabled) = vault.policies(address(account), asset);
    }

    function _spend(VaultHook vault, LoomAccount account, address asset)
        internal
        view
        returns (VaultHook.Spend memory spend)
    {
        (spend.amount, spend.periodStart) = vault.spending(address(account), asset);
    }

    function _vaultState(
        VaultHook vault,
        LoomAccount account,
        MockERC20 token,
        bytes32 withdrawalId,
        MockValidator validator
    ) internal view returns (VaultStateSnapshot memory snapshot) {
        snapshot.pending = _pendingWithdrawal(vault, account, withdrawalId);
        snapshot.policy = _vaultPolicy(vault, account, address(token));
        snapshot.spend = _spend(vault, account, address(token));
        snapshot.configHash = account.configHash();
        snapshot.validator = address(validator);
        snapshot.accountBalance = token.balanceOf(address(account));
        snapshot.recipientBalance = token.balanceOf(address(0xCAFE));
        snapshot.validatorNonce = account.directExecutionNonces(address(validator));
        snapshot.validatorCount = account.validatorCount();
        snapshot.configVersion = account.configVersion();
        snapshot.validatorInstalled = account.isModuleInstalled(ModuleType.VALIDATOR, address(validator));
        snapshot.hookInstalled = account.isModuleInstalled(ModuleType.HOOK, address(vault));
    }

    function _assertVaultStateUnchanged(
        VaultHook vault,
        LoomAccount account,
        MockERC20 token,
        bytes32 withdrawalId,
        VaultStateSnapshot memory expected
    ) internal view {
        VaultHook.PendingWithdrawal memory pending = _pendingWithdrawal(vault, account, withdrawalId);
        assert(pending.readyAt == expected.pending.readyAt);
        assert(pending.expiresAt == expected.pending.expiresAt);
        assert(pending.configVersion == expected.pending.configVersion);
        VaultHook.VaultPolicy memory policy = _vaultPolicy(vault, account, address(token));
        assert(policy.dailyLimit == expected.policy.dailyLimit);
        assert(policy.period == expected.policy.period);
        assert(policy.delay == expected.policy.delay);
        assert(policy.enabled == expected.policy.enabled);
        VaultHook.Spend memory spend = _spend(vault, account, address(token));
        assert(spend.amount == expected.spend.amount);
        assert(spend.periodStart == expected.spend.periodStart);
        assert(account.configHash() == expected.configHash);
        assert(account.configVersion() == expected.configVersion);
        assert(account.validatorCount() == expected.validatorCount);
        assert(account.validatorAt(0) == expected.validator);
        assert(account.directExecutionNonces(expected.validator) == expected.validatorNonce);
        assert(account.isModuleInstalled(ModuleType.VALIDATOR, expected.validator) == expected.validatorInstalled);
        assert(account.isModuleInstalled(ModuleType.HOOK, address(vault)) == expected.hookInstalled);
        assert(token.balanceOf(address(account)) == expected.accountBalance);
        assert(token.balanceOf(address(0xCAFE)) == expected.recipientBalance);
    }

    function testFuzz_VaultWithdrawalDelayIsEnforced(uint256 amount) public {
        check_VaultWithdrawalDelayIsEnforced(amount);
    }

    function check_VaultWithdrawalDelayIsEnforced(uint256 amount) public {
        amount = (amount % 1000) + 11;
        (LoomAccount account, VaultHook vault, MockERC20 token, MockValidator validator) = _accountWithVault();
        token.mint(address(account), amount);
        _setVaultPolicy(account, vault, address(token));

        bytes memory transferCall = abi.encodeCall(MockERC20.transfer, (address(0xCAFE), amount));
        bytes memory scheduleWithdrawal =
            abi.encodeCall(VaultHook.scheduleVaultWithdrawal, (address(token), 0, transferCall, 1 days));
        _executeFromEntryPoint(account, ExecutionLib.Execution(address(vault), 0, scheduleWithdrawal));
        bytes32 withdrawalId = vault.withdrawalIdFor(
            address(account), address(token), 0, keccak256(transferCall), account.configVersion()
        );
        VaultStateSnapshot memory beforeState = _vaultState(vault, account, token, withdrawalId, validator);
        bytes32 mode = account.SINGLE_EXECUTION_MODE();

        vm.prank(account.entryPoint());
        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (mode, abi.encode(ExecutionLib.Execution(address(token), 0, transferCall)))
                )
            );

        assert(!ok);
        _assertRevert(revertData, VaultHook.WithdrawalNotReady.selector);
        _assertVaultStateUnchanged(vault, account, token, withdrawalId, beforeState);
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
        bytes32 mode = account.SINGLE_EXECUTION_MODE();
        VaultStateSnapshot memory beforeState = _vaultState(vault, account, token, withdrawalId, validator);
        vm.prank(account.entryPoint());
        (bool executed, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (mode, abi.encode(ExecutionLib.Execution(address(token), 0, transferCall)))
                )
            );
        assert(!executed);
        _assertRevert(revertData, VaultHook.WithdrawalNotPending.selector);
        _assertVaultStateUnchanged(vault, account, token, withdrawalId, beforeState);
    }

    function _accountWithVault()
        internal
        returns (LoomAccount account, VaultHook vault, MockERC20 token, MockValidator validator)
    {
        validator = new MockValidator();
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
