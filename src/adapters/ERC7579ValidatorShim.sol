// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Validator} from "../interfaces/IERC7579Validator.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @notice Inbound adapter that lets one standard ERC-7579 validator module run
/// as a Loom validator on one Loom account, without changing the Loom core.
///
/// @dev One shim binds one (account, target) pair immutably and holds no state.
/// This 1:1 binding is required for correctness: a standard ERC-7579 validator
/// keys its per-account state by `msg.sender`, and from the target's view
/// `msg.sender` is always this shim. A shim shared across accounts would collapse
/// every account onto one target-side identity. Binding one account per shim
/// makes the target's `msg.sender` a faithful stand-in for that account, in both
/// the lifecycle calls and validation.
///
/// Honest boundary: Loom hands validators a deconstructed profile
/// `(account, userOpHash, nonce, signature, callData, paymaster)`, not the full
/// PackedUserOperation. The reconstructed userOp therefore carries zeroed
/// `initCode`, gas limits, and `preVerificationGas`, and a `paymasterAndData`
/// holding only the 20-byte paymaster address. Modules that read gas fields,
/// initCode, or paymaster data beyond the address are NOT supported through this
/// shim. Executor and fallback modules are out of scope by design.
contract ERC7579ValidatorShim is ILoomValidator {
    error InvalidTarget();
    error OnlyBoundAccount();
    error InvalidAccountState();

    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    address public immutable account;
    IERC7579Validator public immutable target;

    constructor(address account_, IERC7579Validator target_) {
        if (account_ == address(0) || address(target_).code.length == 0 || !target_.isModuleType(ModuleType.VALIDATOR)) revert InvalidTarget();
        account = account_;
        target = target_;
    }

    /// @dev Forwarded by the bound account during installModule (which sets the
    /// module installed before calling initData). Mirrors ERC7579ModuleAdapter.
    function onInstall(bytes calldata data) external {
        if (msg.sender != account) revert OnlyBoundAccount();
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.VALIDATOR, address(this))) {
            revert InvalidAccountState();
        }
        target.onInstall(data);
    }

    /// @dev Forwarded by the bound account during uninstallModule (which clears
    /// the module before calling deInitData).
    function onUninstall(bytes calldata data) external {
        if (msg.sender != account) revert OnlyBoundAccount();
        if (ILoomAccount(account).isModuleInstalled(ModuleType.VALIDATOR, address(this))) {
            revert InvalidAccountState();
        }
        target.onUninstall(data);
    }

    function validateUserOp(
        address account_,
        bytes32 userOpHash,
        uint256 nonce,
        bytes calldata signature,
        bytes calldata callData,
        address paymaster
    ) external returns (uint256) {
        // Native Loom validators are view functions, so their ungated
        // validateUserOp is harmless. The foreign target may be stateful (the
        // standard allows usage counters etc.) and treats msg.sender == shim as
        // the account's authority, so only the bound account may drive it: an
        // ungated shim would let anyone mutate target state in the account's
        // name. A reverting target is caught by the account and mapped to
        // SIG_VALIDATION_FAILED.
        if (msg.sender != account || account_ != account) revert OnlyBoundAccount();
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: account,
            nonce: nonce,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: paymaster == address(0) ? bytes("") : abi.encodePacked(paymaster),
            signature: signature
        });
        return target.validateUserOp(userOp, userOpHash);
    }

    function isValidSignature(address account_, bytes32 hash, bytes calldata signature) external view returns (bool) {
        if (account_ != account) return false;
        return target.isValidSignatureWithSender(account, hash, signature) == ERC1271_MAGIC_VALUE;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function isInitialized(address account_) external view returns (bool) {
        return account_ == account && ILoomAccount(account).isModuleInstalled(ModuleType.VALIDATOR, address(this));
    }
}
