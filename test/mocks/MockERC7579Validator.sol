// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Validator} from "../../src/interfaces/IERC7579Validator.sol";
import {ECDSA} from "../../src/libraries/ECDSA.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @dev Ownable-style standard ERC-7579 validator, modeled on real modules
/// (e.g. Rhinestone OwnableValidator): it keys the owner by `msg.sender`, which
/// through the shim is the shim address. Records the last observed userOp.sender
/// so tests can prove the shim reconstructs it as the Loom account.
contract MockERC7579Validator is IERC7579Validator {
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant VALIDATION_SUCCESS = 0;
    uint256 private constant VALIDATION_FAILED = 1;

    mapping(address installer => address owner) public owners;
    address public lastObservedSender;
    uint256 public lastObservedNonce;

    function onInstall(bytes calldata data) external {
        require(owners[msg.sender] == address(0), "already installed");
        owners[msg.sender] = abi.decode(data, (address));
    }

    function onUninstall(bytes calldata) external {
        require(owners[msg.sender] != address(0), "not installed");
        delete owners[msg.sender];
    }

    function isModuleType(uint256 typeID) external pure returns (bool) {
        return typeID == ModuleType.VALIDATOR;
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256) {
        lastObservedSender = userOp.sender;
        lastObservedNonce = userOp.nonce;
        address owner = owners[msg.sender];
        if (owner != address(0) && ECDSA.recover(userOpHash, userOp.signature) == owner) return VALIDATION_SUCCESS;
        return VALIDATION_FAILED;
    }

    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata data) external view returns (bytes4) {
        address owner = owners[msg.sender];
        if (owner != address(0) && ECDSA.recover(hash, data) == owner) return ERC1271_MAGIC_VALUE;
        return 0xffffffff;
    }
}
