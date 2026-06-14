// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC7579ModuleAdapter} from "../../src/adapters/ERC7579ModuleAdapter.sol";
import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {ILoomModule} from "../../src/interfaces/ILoomModule.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

contract MockERC7579HookAdapter is ERC7579ModuleAdapter, ILoomHook {
    mapping(address account => bytes32 dataHash) public installDataHashes;
    mapping(address account => bytes32 dataHash) public uninstallDataHashes;

    function moduleTypeId() public pure override returns (uint256) {
        return ModuleType.HOOK;
    }

    function isModuleType(uint256 requestedTypeId)
        public
        pure
        override(ERC7579ModuleAdapter, ILoomModule)
        returns (bool)
    {
        return requestedTypeId == moduleTypeId();
    }

    function preCheck(address, address, bytes calldata) external pure returns (bytes memory) {
        return "";
    }

    function postCheck(address, bytes calldata) external pure {}

    function _onInstall(address account, bytes calldata data) internal override {
        installDataHashes[account] = keccak256(data);
    }

    function _onUninstall(address account, bytes calldata data) internal override {
        uninstallDataHashes[account] = keccak256(data);
    }
}
