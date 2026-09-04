// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

library ModuleType {
    uint256 internal constant VALIDATOR = 1;
    uint256 internal constant EXECUTOR = 2;
    uint256 internal constant FALLBACK = 3;
    uint256 internal constant HOOK = 4;
    uint256 internal constant RECOVERY = 5;
    uint256 internal constant MIGRATION = 6;
}
