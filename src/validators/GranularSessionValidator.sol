// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ECDSA} from "../libraries/ECDSA.sol";
import {ERC20CallLib} from "../libraries/ERC20CallLib.sol";
import {ExecutionLib} from "../libraries/ExecutionLib.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";

interface ILoomSessionExecution {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

/// @notice Session validator that grants reusable capability ranges: a session
/// key may perform calls bounded by target, selector, token, counterparty,
/// per-call and per-userOp amounts, uses, and validity window.
/// @dev For approving one known, pre-constructed operation, prefer
/// ExactCallSessionValidator - it pins the exact calldata hash and is the
/// narrowest possible session profile.
contract GranularSessionValidator is ILoomValidator {
    error InvalidPermission();
    error ConfigTimelockRequired();
    error PermissionLimitReached();

    struct Permission {
        address signer;
        address target;
        address token;
        address counterparty;
        address allowedPaymaster;
        bytes4 selector;
        uint128 maxAmountPerCall;
        uint128 maxAmountPerUserOp;
        uint48 validAfter;
        uint48 validUntil;
        uint32 maxUses;
        uint16 maxCallsPerUserOp;
    }

    bytes32 public constant SINGLE_EXECUTION_MODE = ExecutionLib.SINGLE_EXECUTION_MODE;
    bytes32 public constant BATCH_EXECUTION_MODE = ExecutionLib.BATCH_EXECUTION_MODE;
    uint256 public constant MAX_PERMISSION_IDS = 256;

    mapping(address account => mapping(bytes32 permissionId => Permission)) public permissions;
    mapping(address account => mapping(bytes32 permissionId => bool)) public revoked;
    mapping(address account => bytes32[]) private _permissionIds;
    mapping(address account => mapping(bytes32 permissionId => bool)) private _knownPermission;
    mapping(address account => mapping(uint192 nonceKey => bytes32 permissionId)) private _permissionIdByNonceKey;

    event PermissionGranted(address indexed account, bytes32 indexed permissionId, address indexed signer);
    event PermissionBatchGranted(address indexed account, uint256 count);
    event PermissionRevoked(address indexed account, bytes32 indexed permissionId);

    function grantPermission(bytes32 permissionId, Permission calldata permission) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        _grantPermission(msg.sender, permissionId, permission);
        ILoomAccount(msg.sender)
            .notifyConfigChange(keccak256(abi.encode("GRANULAR_SESSION_PERMISSION", permissionId, permission)));
    }

    function grantPermissions(bytes32[] calldata permissionIds, Permission[] calldata newPermissions) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (permissionIds.length == 0 || permissionIds.length != newPermissions.length) revert InvalidPermission();

        for (uint256 i; i < permissionIds.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (permissionIds[i] == permissionIds[j]) revert InvalidPermission();
            }
            _grantPermission(msg.sender, permissionIds[i], newPermissions[i]);
        }

        ILoomAccount(msg.sender)
            .notifyConfigChange(
                keccak256(abi.encode("GRANULAR_SESSION_PERMISSION_BATCH", permissionIds, newPermissions))
            );
        emit PermissionBatchGranted(msg.sender, permissionIds.length);
    }

    function _grantPermission(address account, bytes32 permissionId, Permission calldata permission) internal {
        if (
            permissionId == bytes32(0) || permission.signer == address(0) || permission.target == address(0)
                || permission.selector == bytes4(0) || permission.validUntil <= permission.validAfter
                || permission.maxUses == 0 || permission.maxCallsPerUserOp == 0
                || permission.maxAmountPerUserOp < permission.maxAmountPerCall
                || (permission.token != address(0) && permission.token != permission.target)
                || (permission.token == address(0) && permission.counterparty != address(0))
                || (permission.token != address(0) && !ERC20CallLib.isTokenSelector(permission.selector))
        ) revert InvalidPermission();

        if (!_knownPermission[account][permissionId]) {
            uint192 nonceKey = _nonceKey(permissionId);
            if (_permissionIdByNonceKey[account][nonceKey] != bytes32(0)) revert InvalidPermission();
            _permissionIdByNonceKey[account][nonceKey] = permissionId;
            if (_permissionIds[account].length >= MAX_PERMISSION_IDS) revert PermissionLimitReached();
            _knownPermission[account][permissionId] = true;
            _permissionIds[account].push(permissionId);
        }
        permissions[account][permissionId] = permission;
        revoked[account][permissionId] = false;
        emit PermissionGranted(account, permissionId, permission.signer);
    }

    function revokePermission(bytes32 permissionId) external {
        revoked[msg.sender][permissionId] = true;
        emit PermissionRevoked(msg.sender, permissionId);
    }

    function permissionCount(address account) external view returns (uint256) {
        return _permissionIds[account].length;
    }

    function permissionIdAt(address account, uint256 index) external view returns (bytes32) {
        return _permissionIds[account][index];
    }

    function validateUserOp(
        address account,
        bytes32 userOpHash,
        uint256 nonce,
        bytes calldata signature,
        bytes calldata callData,
        address paymaster
    ) external view returns (uint256) {
        (bytes32 permissionId, bytes memory signerSignature) = abi.decode(signature, (bytes32, bytes));
        Permission memory permission = permissions[account][permissionId];
        if (
            revoked[account][permissionId] || permission.signer == address(0)
                // The ERC-4337 nonce layout deliberately truncates to a 192-bit key and 64-bit sequence.
                // forge-lint: disable-next-line(unsafe-typecast)
                || uint192(nonce >> 64) != _nonceKey(permissionId)
                // forge-lint: disable-next-line(unsafe-typecast)
                || uint64(nonce) >= permission.maxUses || paymaster != permission.allowedPaymaster
                || ECDSA.recover(userOpHash, signerSignature) != permission.signer
                || !_allowsAccountCall(permission, callData)
        ) return ValidationDataLib.SIG_VALIDATION_FAILED;

        return ValidationDataLib.pack(false, permission.validUntil, permission.validAfter);
    }

    function nonceKeyFor(bytes32 permissionId) external pure returns (uint192) {
        return _nonceKey(permissionId);
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function _allowsAccountCall(Permission memory permission, bytes calldata accountCall) internal pure returns (bool) {
        if (accountCall.length < 4 || bytes4(accountCall[:4]) != ILoomSessionExecution.execute.selector) return false;
        (bytes32 mode, bytes memory executionCalldata) = abi.decode(accountCall[4:], (bytes32, bytes));

        if (mode == SINGLE_EXECUTION_MODE) {
            if (permission.maxCallsPerUserOp < 1) return false;
            (bool allowed,) = _allowsExecution(permission, abi.decode(executionCalldata, (ExecutionLib.Execution)));
            return allowed;
        }
        if (mode != BATCH_EXECUTION_MODE) return false;

        ExecutionLib.Execution[] memory executions = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
        if (executions.length == 0 || executions.length > permission.maxCallsPerUserOp) return false;

        uint256 totalAmount = 0;
        for (uint256 i; i < executions.length; ++i) {
            (bool allowed, uint256 amount) = _allowsExecution(permission, executions[i]);
            if (!allowed) return false;
            totalAmount += amount;
            if (totalAmount > permission.maxAmountPerUserOp) return false;
        }
        return true;
    }

    function _allowsExecution(Permission memory permission, ExecutionLib.Execution memory execution)
        internal
        pure
        returns (bool allowed, uint256 amount)
    {
        if (execution.target != permission.target || ERC20CallLib.selector(execution.callData) != permission.selector) {
            return (false, 0);
        }

        if (permission.token == address(0)) {
            if (permission.counterparty != address(0)) return (false, 0);
            amount = execution.value;
        } else {
            if (execution.value != 0) return (false, 0);
            // The session counterparty is the recipient or spender: `to` for
            // transfer, the spender for approve, and the recipient for transferFrom.
            (bool parsed,, address counterparty, uint256 tokenAmount) = ERC20CallLib.decodeTokenCall(execution.callData);
            if (!parsed || permission.counterparty != address(0) && counterparty != permission.counterparty) {
                return (false, 0);
            }
            amount = tokenAmount;
        }

        return (amount <= permission.maxAmountPerCall && amount <= permission.maxAmountPerUserOp, amount);
    }

    function _nonceKey(bytes32 permissionId) internal pure returns (uint192) {
        // The ERC-4337 nonce key is exactly 192 bits; Loom binds each permission
        // ID to this truncated key and rejects any second permission sharing it.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint192(bytes24(permissionId));
    }
}
