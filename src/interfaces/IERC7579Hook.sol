// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Standard ERC-7579 hook module surface, as implemented by third-party
/// modules. Loom does not implement this interface on its account;
/// `ERC7579HookShim` calls it on a foreign module. Module type 4 (HOOK) matches
/// Loom's `ModuleType`. This targets the current single-argument `postCheck`
/// form of the standard.
interface IERC7579Hook {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 typeID) external view returns (bool);
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);
    function postCheck(bytes calldata hookData) external;
}
