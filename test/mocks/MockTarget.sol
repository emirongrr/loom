// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

contract MockTarget {
    uint256 public value;

    function setValue(uint256 newValue) external payable {
        value = newValue;
    }

    function fail() external pure {
        revert("FAIL");
    }
}
