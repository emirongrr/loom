// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Hook} from "../interfaces/IERC7579Hook.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomHook} from "../interfaces/ILoomHook.sol";
import {ModuleType} from "../libraries/ModuleType.sol";

/// @notice Inbound adapter that lets one standard ERC-7579 hook module run as a
/// Loom hook on one Loom account, without changing the Loom core.
///
/// @dev One shim binds one (account, target) pair immutably and holds no state,
/// for the same reason as ERC7579ValidatorShim: a standard hook keys its state
/// by `msg.sender`, which from the target's view is always this shim.
///
/// Interface mapping: Loom calls `preCheck(account, caller, accountCall)`; the
/// standard hook expects `preCheck(msgSender, msgValue, msgData)`. `caller` (the
/// EntryPoint or the account on a self-call) maps to `msgSender`, and
/// `accountCall` maps to `msgData`. `msgValue` is passed as 0: Loom's hook
/// callback does not carry the top-level call value, and per-execution values
/// live inside `accountCall`. Hooks that gate on top-level `msgValue` are not
/// supported through this shim. Targets the single-argument `postCheck` form.
contract ERC7579HookShim is ILoomHook {
    error InvalidTarget();
    error OnlyBoundAccount();
    error InvalidAccountState();

    address public immutable account;
    IERC7579Hook public immutable target;

    constructor(address account_, IERC7579Hook target_) {
        if (account_ == address(0) || address(target_).code.length == 0 || !target_.isModuleType(ModuleType.HOOK)) {
            revert InvalidTarget();
        }
        account = account_;
        target = target_;
    }

    function onInstall(bytes calldata data) external {
        if (msg.sender != account) revert OnlyBoundAccount();
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, address(this))) revert InvalidAccountState();
        target.onInstall(data);
    }

    function onUninstall(bytes calldata data) external {
        if (msg.sender != account) revert OnlyBoundAccount();
        if (ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, address(this))) revert InvalidAccountState();
        target.onUninstall(data);
    }

    function preCheck(address account_, address caller, bytes calldata accountCall) external returns (bytes memory) {
        if (msg.sender != account || account_ != account) revert OnlyBoundAccount();
        return target.preCheck(caller, 0, accountCall);
    }

    function postCheck(address account_, bytes calldata hookData) external {
        if (msg.sender != account || account_ != account) revert OnlyBoundAccount();
        target.postCheck(hookData);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }

    function isInitialized(address account_) external view returns (bool) {
        return account_ == account && ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, address(this));
    }
}
