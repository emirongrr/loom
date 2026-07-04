// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ECDSA} from "../libraries/ECDSA.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";

/// @notice Session validator that pins a permission to the hash of ONE complete
/// account call: the session key may submit exactly that operation, up to
/// maxUses times, inside its validity window.
/// @dev This is the narrowest session profile - prefer it whenever the
/// operation is known and pre-constructed at grant time. For reusable
/// capability ranges (per-target/selector/token/amount bounds) use
/// GranularSessionValidator instead; the two are deliberately separate because
/// merging exact-call pinning into the granular permission struct would fatten
/// every grant with fields most sessions never use.
contract ExactCallSessionValidator is ILoomValidator {
    error InvalidPermission();
    error ConfigTimelockRequired();

    struct Permission {
        address signer;
        uint48 validAfter;
        uint48 validUntil;
        bytes32 callHash;
        uint32 maxUses;
        address allowedPaymaster;
    }

    mapping(address account => mapping(bytes32 permissionId => Permission)) public permissions;
    mapping(address account => mapping(bytes32 permissionId => bool)) public revoked;

    event PermissionGranted(address indexed account, bytes32 indexed permissionId, address indexed signer);
    event PermissionRevoked(address indexed account, bytes32 indexed permissionId);

    function grantPermission(bytes32 permissionId, Permission calldata permission) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (
            permissionId == bytes32(0) || permission.signer == address(0)
                || permission.validUntil <= permission.validAfter || permission.maxUses == 0
        ) {
            revert InvalidPermission();
        }
        permissions[msg.sender][permissionId] = permission;
        revoked[msg.sender][permissionId] = false;
        ILoomAccount(msg.sender)
            .notifyConfigChange(keccak256(abi.encode("SESSION_PERMISSION", permissionId, permission)));
        emit PermissionGranted(msg.sender, permissionId, permission.signer);
    }

    function revokePermission(bytes32 permissionId) external {
        revoked[msg.sender][permissionId] = true;
        emit PermissionRevoked(msg.sender, permissionId);
    }

    function validateUserOp(
        address account,
        bytes32 userOpHash,
        uint256 nonce,
        bytes calldata signature,
        bytes calldata callData,
        address paymaster
    ) external view returns (uint256) {
        (bytes32 permissionId, bytes memory signerSignature, bytes32 callHash) =
            abi.decode(signature, (bytes32, bytes, bytes32));
        Permission memory permission = permissions[account][permissionId];
        if (
            revoked[account][permissionId] || permission.signer == address(0)
                // The ERC-4337 nonce layout deliberately truncates to a 192-bit key and 64-bit sequence.
                // forge-lint: disable-next-line(unsafe-typecast)
                || uint192(nonce >> 64) != uint192(bytes24(permissionId))
                // forge-lint: disable-next-line(unsafe-typecast)
                || uint64(nonce) >= permission.maxUses || keccak256(callData) != callHash
                || permission.callHash != callHash || paymaster != permission.allowedPaymaster
                || ECDSA.recover(userOpHash, signerSignature) != permission.signer
        ) return ValidationDataLib.SIG_VALIDATION_FAILED;
        return ValidationDataLib.pack(false, permission.validUntil, permission.validAfter);
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        // Session permissions authorize UserOperations, never arbitrary ERC-1271 messages.
        return false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }
}
