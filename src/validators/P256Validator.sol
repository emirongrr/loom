// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {ILoomDirectValidator} from "../interfaces/ILoomDirectValidator.sol";
import {IPolicyHook} from "../interfaces/IPolicyHook.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {WebAuthnP256} from "../libraries/WebAuthnP256.sol";

contract P256Validator is ILoomValidator, ILoomDirectValidator {
    error InvalidPublicKey();
    error KeyAlreadyInitialized();
    error ConfigTimelockRequired();
    error InvalidPolicyHook();

    // Re-exported from WebAuthnP256 (the single source of truth that enforces
    // them) so external callers and tests read the same bounds the library applies.
    uint256 public constant MAX_AUTHENTICATOR_DATA_LENGTH = WebAuthnP256.MAX_AUTHENTICATOR_DATA_LENGTH;
    uint256 public constant MAX_CLIENT_DATA_JSON_LENGTH = WebAuthnP256.MAX_CLIENT_DATA_JSON_LENGTH;
    uint256 public constant MAX_ORIGIN_LENGTH = WebAuthnP256.MAX_ORIGIN_LENGTH;
    uint256 public constant P256_HALF_ORDER = WebAuthnP256.P256_HALF_ORDER;

    struct PublicKey {
        bytes32 x;
        bytes32 y;
        bytes32 rpIdHash;
        bytes32 originHash;
    }

    struct WebAuthnSignature {
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes origin;
        bytes32 r;
        bytes32 s;
    }

    address public immutable fallbackVerifier;
    mapping(address account => PublicKey) public publicKeys;
    mapping(address account => address) public policyHooks;

    event KeySet(address indexed account, bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash);
    event PolicyHookSet(address indexed account, address indexed hook);

    constructor(address fallbackVerifier_) {
        fallbackVerifier = fallbackVerifier_;
    }

    function initialize(bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash, address policyHook) external {
        if (publicKeys[msg.sender].x != bytes32(0)) revert KeyAlreadyInitialized();
        if (policyHook == address(0)) revert InvalidPolicyHook();
        _setKey(msg.sender, x, y, rpIdHash, originHash);
        policyHooks[msg.sender] = policyHook;
        emit PolicyHookSet(msg.sender, policyHook);
    }

    function setKey(bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        _setKey(msg.sender, x, y, rpIdHash, originHash);
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("P256_KEY", x, y, rpIdHash, originHash)));
    }

    function setPolicyHook(address hook) external {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
        if (hook == address(0) || !ILoomAccount(msg.sender).isModuleInstalled(ModuleType.HOOK, hook)) {
            revert InvalidPolicyHook();
        }
        policyHooks[msg.sender] = hook;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("P256_POLICY_HOOK", hook)));
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
        if (hook == address(0)) {
            return ValidationDataLib.SIG_VALIDATION_FAILED;
        }
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)) {
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
        if (hook == address(0)) return false;
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)) return false;
        if (!IPolicyHook(hook).isLowRisk(account, accountCall)) return false;
        return _verify(account, executionHash, signature);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function _setKey(address account, bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash) internal {
        if (!WebAuthnP256.isValidKey(WebAuthnP256.PublicKey(x, y, rpIdHash, originHash))) revert InvalidPublicKey();
        publicKeys[account] = PublicKey(x, y, rpIdHash, originHash);
        emit KeySet(account, x, y, rpIdHash, originHash);
    }

    function _verify(address account, bytes32 hash, bytes calldata signature) internal view returns (bool) {
        WebAuthnSignature memory webAuthn = abi.decode(signature, (WebAuthnSignature));
        PublicKey memory key = publicKeys[account];
        return WebAuthnP256.verify(
            WebAuthnP256.PublicKey(key.x, key.y, key.rpIdHash, key.originHash),
            hash,
            WebAuthnP256.Signature(
                webAuthn.authenticatorData, webAuthn.clientDataJSON, webAuthn.origin, webAuthn.r, webAuthn.s
            ),
            fallbackVerifier
        );
    }
}
