// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Per-factory, factory-only membership set for the accounts a single
/// factory deploys. It exists for app-local operational metrics: an institution
/// running Loom as its wallet engine reads `accountCount` for a live account
/// total and gates institution-scoped contracts (e.g. a paymaster) on
/// `isAccount`; account lists and TVL are built off-chain from
/// `AccountRegistered` events.
/// @dev Grants no account authority and is intentionally not enumerable
/// on-chain. It records single-account membership with no owner-to-accounts
/// linkage, so it does not connect a user's accounts. There is no global Loom
/// registry; each factory deploys its own. See docs/decisions/0009 and 0004.
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
