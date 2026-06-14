// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPolicyHook {
    function isLowRisk(address account, bytes calldata accountCall) external view returns (bool);
}
