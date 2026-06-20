// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

contract AppAccountRegistry {
    error OnlyFactory();
    error InvalidAccount();
    error AccountAlreadyRegistered();

    address public immutable factory;
    uint256 public accountCount;
    mapping(address account => bool registered) public isAccount;

    event AccountRegistered(address indexed account);

    constructor(address factory_) {
        if (factory_ == address(0)) revert OnlyFactory();
        factory = factory_;
    }

    function registerAccount(address account) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (account.code.length == 0) revert InvalidAccount();
        if (isAccount[account]) revert AccountAlreadyRegistered();
        isAccount[account] = true;
        ++accountCount;
        emit AccountRegistered(account);
    }
}
