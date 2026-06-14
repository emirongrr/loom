// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Module} from "../interfaces/IERC7579Module.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomModule} from "../interfaces/ILoomModule.sol";

/// @notice Standard ERC-7579 lifecycle surface for modules that also implement
/// Loom's deliberately narrower validator, hook, or recovery runtime interface.
/// @dev Loom callers must pass abi.encodeCall(onInstall/onUninstall, (data)) as
/// lifecycle calldata. This adapter does not enable executor or fallback modules.
abstract contract ERC7579ModuleAdapter is IERC7579Module, ILoomModule {
    error AlreadyInstalled();
    error NotInstalled();
    error InvalidAccountState();

    mapping(address account => bool installed) private _installed;

    function onInstall(bytes calldata data) external {
        if (_installed[msg.sender]) revert AlreadyInstalled();
        if (!ILoomAccount(msg.sender).isModuleInstalled(moduleTypeId(), address(this))) revert InvalidAccountState();
        _installed[msg.sender] = true;
        _onInstall(msg.sender, data);
    }

    function onUninstall(bytes calldata data) external {
        if (!_installed[msg.sender]) revert NotInstalled();
        if (ILoomAccount(msg.sender).isModuleInstalled(moduleTypeId(), address(this))) revert InvalidAccountState();
        delete _installed[msg.sender];
        _onUninstall(msg.sender, data);
    }

    function isModuleType(uint256 requestedTypeId)
        public
        pure
        virtual
        override(IERC7579Module, ILoomModule)
        returns (bool)
    {
        return requestedTypeId == moduleTypeId();
    }

    function isInitialized(address account) external view returns (bool) {
        return _installed[account];
    }

    function moduleTypeId() public pure virtual returns (uint256);
    function _onInstall(address account, bytes calldata data) internal virtual;
    function _onUninstall(address account, bytes calldata data) internal virtual;
}
