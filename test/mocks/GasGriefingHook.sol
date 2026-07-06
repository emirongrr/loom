// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomHook} from "../../src/interfaces/ILoomHook.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

/// @notice Adversarial hook that consumes a configurable amount of gas during
///         preCheck to verify that gas-griefing attacks are bounded and do not
///         prevent hook eviction or recovery paths.
contract GasGriefingHook is ILoomHook {
    uint256 public gasToConsume;

    constructor(uint256 gasToConsume_) {
        gasToConsume = gasToConsume_;
    }

    function setGasToConsume(uint256 amount) external {
        gasToConsume = amount;
    }

    function preCheck(address, address, bytes calldata) external view returns (bytes memory) {
        uint256 target = gasleft() > gasToConsume ? gasleft() - gasToConsume : 0;
        // Spin until gas consumed. This does NOT infinite-loop: it burns at most
        // `gasToConsume` gas because the loop condition checks gasleft().
        while (gasleft() > target) {}
        return "";
    }

    function postCheck(address, bytes calldata) external pure {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.HOOK;
    }
}
