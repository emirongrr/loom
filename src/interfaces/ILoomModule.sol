// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface ILoomModule {
    function isModuleType(uint256 moduleTypeId) external pure returns (bool);
}
