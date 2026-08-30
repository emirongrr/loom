// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Per-factory, factory-only membership set for the accounts a single
/// factory deploys. It exists for app-local operational metrics: an institution
/// running Loom as its wallet engine reads `accountCount` for a live account
/// total and gates institution-scoped contracts (e.g. a paymaster) on
/// `isAccount`; account lists and TVL are built off-chain from
/// `AccountRegistered` events. It also resolves the random RP account handle
/// carried by new passkeys to exactly one account.
/// @dev Grants no account authority and is intentionally not enumerable
/// on-chain. Account handles are random, per-factory, and bind one account;
/// live validators remain the only source of signing authority. There is no
/// global Loom registry. See docs/decisions/0009, 0004, and 0027.
contract AppAccountRegistry {
    error OnlyFactory();
    error InvalidAccount();
    error AccountAlreadyRegistered();
    error InvalidAccountHandle();
    error AccountHandleAlreadyRegistered();

    address public immutable factory;
    uint256 public accountCount;
    mapping(address account => bool registered) public isAccount;
    mapping(bytes32 handle => address account) public accountForHandle;
    mapping(address account => bytes32 handle) public handleForAccount;

    event AccountRegistered(address indexed account);
    event AccountHandleRegistered(bytes32 indexed handle, address indexed account);

    constructor(address factory_) {
        if (factory_ == address(0)) revert OnlyFactory();
        factory = factory_;
    }

    function registerAccount(bytes32 handle, address account) external {
        _requireFactory();
        if (handle == bytes32(0)) revert InvalidAccountHandle();
        if (accountForHandle[handle] != address(0)) revert AccountHandleAlreadyRegistered();
        _registerAccount(account);
        accountForHandle[handle] = account;
        handleForAccount[account] = handle;
        emit AccountHandleRegistered(handle, account);
    }

    function _requireFactory() private view {
        if (msg.sender != factory) revert OnlyFactory();
    }

    function _registerAccount(address account) private {
        if (account.code.length == 0) revert InvalidAccount();
        if (isAccount[account]) revert AccountAlreadyRegistered();
        isAccount[account] = true;
        ++accountCount;
        emit AccountRegistered(account);
    }
}
