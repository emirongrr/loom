// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ILoomDirectValidator} from "../interfaces/ILoomDirectValidator.sol";
import {IPolicyHook} from "../interfaces/IPolicyHook.sol";
import {ECDSA} from "../libraries/ECDSA.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";

contract ECDSAValidator is ILoomValidator, ILoomDirectValidator {
    error AlreadyInitialized();
    error InvalidOwner();
    error ConfigTimelockRequired();
    error InvalidPolicyHook();

    mapping(address account => address) public owners;
    mapping(address account => address) public policyHooks;

    event OwnerSet(address indexed account, address indexed owner);
    event PolicyHookSet(address indexed account, address indexed hook);

    function initialize(address owner, address policyHook) external {
        if (owners[msg.sender] != address(0)) revert AlreadyInitialized();
        if (policyHook == address(0)) revert InvalidPolicyHook();
        _setOwner(msg.sender, owner);
        policyHooks[msg.sender] = policyHook;
        emit PolicyHookSet(msg.sender, policyHook);
    }

    function setOwner(address owner) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        _setOwner(msg.sender, owner);
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("ECDSA_OWNER", owner)));
    }

    function setPolicyHook(address hook) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (hook == address(0) || !ILoomAccount(msg.sender).isModuleInstalled(ModuleType.HOOK, hook)) {
            revert InvalidPolicyHook();
        }
        policyHooks[msg.sender] = hook;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("ECDSA_POLICY_HOOK", hook)));
        emit PolicyHookSet(msg.sender, hook);
    }

    function validateUserOp(
        address account,
        bytes32 userOpHash,
        uint256,
        bytes calldata signature,
        bytes calldata,
        address
    ) external view returns (uint256) {
        address hook = policyHooks[account];
        if (hook == address(0) || !ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)) {
            return ValidationDataLib.SIG_VALIDATION_FAILED;
        }
        return _verify(account, userOpHash, signature) ? 0 : ValidationDataLib.SIG_VALIDATION_FAILED;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        // A hash alone cannot be classified by PolicyHook.
        return false;
    }

    function validateDirectExecution(
        address account,
        bytes32 executionHash,
        bytes calldata signature,
        bytes calldata accountCall
    ) external view returns (bool) {
        address hook = policyHooks[account];
        return hook != address(0) && ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)
            && IPolicyHook(hook).isLowRisk(account, accountCall) && _verify(account, executionHash, signature);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function _setOwner(address account, address owner) internal {
        if (owner == address(0)) revert InvalidOwner();
        owners[account] = owner;
        emit OwnerSet(account, owner);
    }

    function _verify(address account, bytes32 hash, bytes calldata signature) internal view returns (bool) {
        return ECDSA.recover(hash, signature) == owners[account];
    }
}
