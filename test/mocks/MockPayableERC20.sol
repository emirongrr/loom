// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @dev Models tokens whose transfer functions accept attached ETH. Standard
/// ERC-20 implementations revert on value, which would mask the vault-policy
/// reclassification hole this mock exists to exercise.
contract MockPayableERC20 {
    mapping(address account => uint256) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transfer(address to, uint256 amount) external payable returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
