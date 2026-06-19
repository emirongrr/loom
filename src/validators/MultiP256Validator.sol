// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomDirectValidator} from "../interfaces/ILoomDirectValidator.sol";
import {ILoomValidator} from "../interfaces/ILoomValidator.sol";
import {IPolicyHook} from "../interfaces/IPolicyHook.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {ValidationDataLib} from "../libraries/ValidationDataLib.sol";
import {WebAuthnP256} from "../libraries/WebAuthnP256.sol";

contract MultiP256Validator is ILoomValidator, ILoomDirectValidator {
    error AlreadyInitialized();
    error InvalidCredential();
    error DuplicateCredential();
    error InvalidThreshold();
    error ConfigTimelockRequired();
    error InvalidPolicyHook();
    error CredentialLimitReached();

    uint256 public constant MAX_CREDENTIALS = 16;

    struct CredentialInit {
        bytes32 credentialId;
        WebAuthnP256.PublicKey key;
    }

    struct CredentialSignature {
        bytes32 credentialId;
        WebAuthnP256.Signature signature;
    }

    address public immutable fallbackVerifier;
    mapping(address account => mapping(bytes32 credentialId => WebAuthnP256.PublicKey)) public credentials;
    mapping(address account => mapping(bytes32 fingerprint => bool)) public keyFingerprints;
    mapping(address account => bytes32[]) private _credentialIds;
    mapping(address account => uint8) public thresholds;
    mapping(address account => address) public policyHooks;

    event CredentialAdded(address indexed account, bytes32 indexed credentialId, bytes32 indexed fingerprint);
    event CredentialRemoved(address indexed account, bytes32 indexed credentialId, bytes32 indexed fingerprint);
    event ThresholdSet(address indexed account, uint8 threshold);
    event PolicyHookSet(address indexed account, address indexed hook);

    constructor(address fallbackVerifier_) {
        fallbackVerifier = fallbackVerifier_;
    }

    function initialize(CredentialInit[] calldata initialCredentials, uint8 threshold, address policyHook) external {
        if (_credentialIds[msg.sender].length != 0) revert AlreadyInitialized();
        if (policyHook == address(0)) revert InvalidPolicyHook();
        if (
            initialCredentials.length == 0 || initialCredentials.length > MAX_CREDENTIALS || threshold == 0
                || threshold > initialCredentials.length
        ) revert InvalidThreshold();

        for (uint256 i; i < initialCredentials.length; ++i) {
            _addCredential(msg.sender, initialCredentials[i].credentialId, initialCredentials[i].key);
        }
        thresholds[msg.sender] = threshold;
        policyHooks[msg.sender] = policyHook;
        emit ThresholdSet(msg.sender, threshold);
        emit PolicyHookSet(msg.sender, policyHook);
    }

    function addCredential(bytes32 credentialId, WebAuthnP256.PublicKey calldata key) external {
        _requireScheduled();
        _addCredential(msg.sender, credentialId, key);
        ILoomAccount(msg.sender)
            .notifyConfigChange(keccak256(abi.encode("MULTI_P256_CREDENTIAL_ADDED", credentialId, key)));
    }

    function removeCredential(bytes32 credentialId) external {
        _requireScheduled();
        WebAuthnP256.PublicKey memory key = credentials[msg.sender][credentialId];
        if (!WebAuthnP256.isValidKey(key) || _credentialIds[msg.sender].length - 1 < thresholds[msg.sender]) {
            revert InvalidCredential();
        }

        bytes32 fingerprint = WebAuthnP256.fingerprint(key);
        delete credentials[msg.sender][credentialId];
        delete keyFingerprints[msg.sender][fingerprint];
        bytes32[] storage ids = _credentialIds[msg.sender];
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == credentialId) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                break;
            }
        }
        ILoomAccount(msg.sender)
            .notifyConfigChange(keccak256(abi.encode("MULTI_P256_CREDENTIAL_REMOVED", credentialId, fingerprint)));
        emit CredentialRemoved(msg.sender, credentialId, fingerprint);
    }

    function setThreshold(uint8 threshold) external {
        _requireScheduled();
        if (threshold == 0 || threshold > _credentialIds[msg.sender].length) revert InvalidThreshold();
        thresholds[msg.sender] = threshold;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("MULTI_P256_THRESHOLD", threshold)));
        emit ThresholdSet(msg.sender, threshold);
    }

    function setPolicyHook(address hook) external {
        _requireScheduled();
        if (hook == address(0) || !ILoomAccount(msg.sender).isModuleInstalled(ModuleType.HOOK, hook)) {
            revert InvalidPolicyHook();
        }
        policyHooks[msg.sender] = hook;
        ILoomAccount(msg.sender).notifyConfigChange(keccak256(abi.encode("MULTI_P256_POLICY_HOOK", hook)));
        emit PolicyHookSet(msg.sender, hook);
    }

    function credentialCount(address account) external view returns (uint256) {
        return _credentialIds[account].length;
    }

    function credentialIdAt(address account, uint256 index) external view returns (bytes32) {
        return _credentialIds[account][index];
    }

    function validateUserOp(
        address account,
        bytes32 userOpHash,
        uint256,
        bytes calldata encodedSignatures,
        bytes calldata,
        address
    ) external view returns (uint256) {
        address hook = policyHooks[account];
        if (
            hook == address(0) || !ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)
                || !_verifyThreshold(account, userOpHash, encodedSignatures)
        ) return ValidationDataLib.SIG_VALIDATION_FAILED;
        return 0;
    }

    function isValidSignature(address, bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }

    function validateDirectExecution(
        address account,
        bytes32 executionHash,
        bytes calldata encodedSignatures,
        bytes calldata accountCall
    ) external view returns (bool) {
        address hook = policyHooks[account];
        return hook != address(0) && ILoomAccount(account).isModuleInstalled(ModuleType.HOOK, hook)
            && IPolicyHook(hook).isLowRisk(account, accountCall)
            && _verifyThreshold(account, executionHash, encodedSignatures);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function _verifyThreshold(address account, bytes32 hash, bytes calldata encodedSignatures)
        internal
        view
        returns (bool)
    {
        CredentialSignature[] memory signatures = abi.decode(encodedSignatures, (CredentialSignature[]));
        uint256 threshold = thresholds[account];
        if (threshold == 0 || signatures.length < threshold || signatures.length > MAX_CREDENTIALS) return false;

        bytes32 previousId = bytes32(0);
        for (uint256 i; i < signatures.length; ++i) {
            CredentialSignature memory item = signatures[i];
            if (item.credentialId <= previousId) return false;
            previousId = item.credentialId;
            WebAuthnP256.PublicKey memory key = credentials[account][item.credentialId];
            if (!WebAuthnP256.verify(key, hash, item.signature, fallbackVerifier)) return false;
        }
        return true;
    }

    function _addCredential(address account, bytes32 credentialId, WebAuthnP256.PublicKey memory key) internal {
        if (credentialId == bytes32(0) || !WebAuthnP256.isValidKey(key)) revert InvalidCredential();
        if (_credentialIds[account].length >= MAX_CREDENTIALS) revert CredentialLimitReached();
        bytes32 fingerprint = WebAuthnP256.fingerprint(key);
        if (credentials[account][credentialId].x != bytes32(0) || keyFingerprints[account][fingerprint]) {
            revert DuplicateCredential();
        }
        credentials[account][credentialId] = key;
        keyFingerprints[account][fingerprint] = true;
        _credentialIds[account].push(credentialId);
        emit CredentialAdded(account, credentialId, fingerprint);
    }

    function _requireScheduled() internal view {
        if (!ILoomAccount(msg.sender).isExecutingScheduled()) revert ConfigTimelockRequired();
    }
}
