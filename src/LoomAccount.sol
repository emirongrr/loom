// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC1271} from "./interfaces/IERC1271.sol";
import {ILoomAccount} from "./interfaces/ILoomAccount.sol";
import {ILoomDirectValidator} from "./interfaces/ILoomDirectValidator.sol";
import {ILoomHook} from "./interfaces/ILoomHook.sol";
import {ILoomModule} from "./interfaces/ILoomModule.sol";
import {ILoomValidator} from "./interfaces/ILoomValidator.sol";
import {IGuardianVerifier} from "./interfaces/IGuardianVerifier.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {EIP712Lib} from "./libraries/EIP712Lib.sol";
import {ExecutionLib} from "./libraries/ExecutionLib.sol";
import {ModuleType} from "./libraries/ModuleType.sol";
import {ValidationDataLib} from "./libraries/ValidationDataLib.sol";
import {ValidatorSetLib} from "./libraries/ValidatorSetLib.sol";
import {MerkleProof} from "./libraries/MerkleProof.sol";
import {GuardianVerificationLib} from "./libraries/GuardianVerificationLib.sol";

contract LoomAccount is IERC1271, ILoomAccount {
    // --- Errors ---
    error OnlyEntryPoint();
    error OnlySelf();
    error InvalidModule();
    error UnsupportedModuleType();
    error UnsupportedExecutionMode();
    error AccountFrozen();
    error InvalidGuardianConfig();
    error InvalidDelay();
    error OperationNotReady();
    error OperationNotScheduled();
    error CallFailed(bytes returnData);
    error InvalidInitialization();
    error Reentrancy();
    error ModuleLimitReached();
    error InvalidTokenAllowance();
    error EmptyBatch();
    error FreezeActive();
    error InvalidDirectExecution();
    error MigrationAlreadyPending();
    error MigrationNotPending();
    error InvalidMigration();
    error OperationAlreadyScheduled();

    // --- Types ---
    struct ModuleInit {
        uint256 moduleTypeId;
        address module;
        bytes initData;
    }

    struct PendingMigration {
        address destination;
        bytes32 destinationCodeHash;
        bytes32 destinationConfigHash;
        bytes32 callsHash;
        uint48 readyAt;
        uint48 expiresAt;
        uint64 configVersion;
        uint64 nonce;
    }

    // --- Constants ---
    /// @notice Minimum schedule delay for calls to external targets.
    /// @dev Configuration targets (the account itself or an installed module)
    /// use the longer MIN_CONFIG_DELAY; see scheduleCall.
    uint48 public constant MIN_EXTERNAL_DELAY = 1 days;
    uint48 public constant MIN_CONFIG_DELAY = 3 days;
    uint48 public constant FREEZE_DURATION = 2 days;
    uint48 public constant MAX_MIGRATION_WINDOW = 30 days;
    uint48 public constant MAX_SCHEDULE_DELAY = 90 days;
    uint256 public constant MAX_VALIDATORS = ValidatorSetLib.MAX_VALIDATORS;
    uint256 public constant MAX_HOOKS = 8;
    uint256 public constant MAX_RECOVERY_MODULES = 1;
    uint8 public constant MAX_GUARDIAN_THRESHOLD = GuardianVerificationLib.MAX_GUARDIAN_THRESHOLD;
    uint256 public constant MAX_GUARDIAN_PROOF_LENGTH = 32;
    bytes32 public constant SINGLE_EXECUTION_MODE = ExecutionLib.SINGLE_EXECUTION_MODE;
    bytes32 public constant BATCH_EXECUTION_MODE = ExecutionLib.BATCH_EXECUTION_MODE;
    bytes4 public constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 public constant ERC1271_INVALID = 0xffffffff;
    bytes4 public constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 public constant ERC721_RECEIVER_INTERFACE_ID = 0x150b7a02;
    bytes4 public constant ERC1155_RECEIVER_INTERFACE_ID = 0x4e2312e0;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = EIP712Lib.DOMAIN_TYPEHASH;
    bytes32 public constant FREEZE_TYPEHASH =
        keccak256("Freeze(bytes32 guardianLeaf,uint256 nonce,uint64 configVersion)");
    bytes32 public constant CANCEL_MIGRATION_TYPEHASH =
        keccak256("CancelMigration(bytes32 migrationId,uint64 configVersion,uint64 nonce)");
    bytes32 public constant DIRECT_EXECUTION_TYPEHASH = keccak256(
        "DirectExecution(address validator,bytes32 mode,bytes32 executionCalldataHash,uint256 nonce,uint64 configVersion,uint48 validUntil)"
    );
    bytes32 public constant EVICT_HOOK_TYPEHASH = keccak256("EvictHook(address hook,uint64 configVersion)");
    bytes32 private constant NAME_HASH = keccak256("LoomAccount");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CONFIGURATION_RECOVERED_HASH = keccak256("CONFIGURATION_RECOVERED");
    bytes32 private constant CONFIGURATION_SET_RECOVERED_HASH = keccak256("CONFIGURATION_SET_RECOVERED");
    bytes4 private constant CANCEL_RECOVERY = bytes4(keccak256("cancelRecovery(address)"));
    uint256 private constant UNINSTALL_MODULE_MIN_SELECTOR_AND_STATIC_ARGS_SIZE = 100;

    // --- Storage (layout is append-only; order is consensus-critical) ---
    address public entryPoint;
    bytes32 public configHash;
    uint64 public configVersion;
    bytes32 public guardianRoot;
    uint8 public guardianThreshold;
    uint48 public frozenUntil;
    mapping(address validator => uint256 nonce) public directExecutionNonces;

    mapping(uint256 moduleTypeId => mapping(address module => bool)) private _modules;
    address[] private _validators;
    address[] private _hooks;
    uint256 private _validatorCount;
    uint256 private _recoveryModuleCount;
    mapping(bytes32 operationId => uint48 readyAt) public scheduledOperations;
    mapping(bytes32 guardianLeaf => uint256) public freezeNonces;
    mapping(bytes32 guardianLeaf => uint64) public lastFreezeConfigVersion;
    PendingMigration public pendingMigration;
    uint64 public migrationNonce;
    bool private _executingScheduled;
    bool private _executionLocked;

    // --- Events ---
    event ModuleInstalled(uint256 indexed moduleTypeId, address indexed module);
    event ModuleUninstalled(uint256 indexed moduleTypeId, address indexed module);
    event ConfigUpdated(bytes32 indexed configHash, uint64 indexed configVersion);
    event GuardianConfigUpdated(bytes32 indexed guardianRoot, uint8 guardianThreshold);
    event Frozen(uint48 frozenUntil);
    event OperationScheduled(bytes32 indexed operationId, uint48 readyAt);
    event OperationCancelled(bytes32 indexed operationId);
    event OperationExecuted(bytes32 indexed operationId);
    event AllowanceRevoked(address indexed token, address indexed spender);
    event DirectExecution(address indexed validator, uint256 indexed nonce, bytes32 indexed executionHash);
    event MigrationScheduled(
        bytes32 indexed migrationId,
        address indexed destination,
        bytes32 indexed destinationCodeHash,
        bytes32 destinationConfigHash,
        bytes32 callsHash,
        uint48 readyAt,
        uint48 expiresAt
    );
    event MigrationCancelled(bytes32 indexed migrationId);
    event MigrationExecuted(bytes32 indexed migrationId, address indexed destination);

    // --- Initialization ---
    constructor(
        address entryPoint_,
        bytes32 guardianRoot_,
        uint8 guardianThreshold_,
        bytes32 configHash_,
        ModuleInit[] memory modules
    ) payable {
        _initialize(entryPoint_, guardianRoot_, guardianThreshold_, configHash_, modules);
    }

    receive() external payable {}

    function initialize(
        address entryPoint_,
        bytes32 guardianRoot_,
        uint8 guardianThreshold_,
        bytes32 configHash_,
        ModuleInit[] calldata modules
    ) external payable {
        _initialize(entryPoint_, guardianRoot_, guardianThreshold_, configHash_, modules);
    }

    function initializeDelegatedAccount(
        address entryPoint_,
        bytes32 guardianRoot_,
        uint8 guardianThreshold_,
        bytes32 configHash_,
        ModuleInit[] calldata modules
    ) external payable {
        if (msg.sender != address(this)) {
            revert InvalidInitialization();
        }
        _initialize(entryPoint_, guardianRoot_, guardianThreshold_, configHash_, modules);
    }

    // --- ERC-165 and token receiver hooks ---
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID || interfaceId == ERC721_RECEIVER_INTERFACE_ID
            || interfaceId == ERC1155_RECEIVER_INTERFACE_ID;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return ERC721_RECEIVER_INTERFACE_ID;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    // --- Modifiers ---
    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert OnlyEntryPoint();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    modifier onlyScheduledSelf() {
        if (msg.sender != address(this) || !_executingScheduled) revert OperationNotReady();
        _;
    }

    modifier nonReentrantExecution() {
        if (_executionLocked) revert Reentrancy();
        _executionLocked = true;
        _;
        _executionLocked = false;
    }

    // --- ERC-4337 validation and ERC-1271 signatures ---
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        if (userOp.sender != address(this)) return ValidationDataLib.SIG_VALIDATION_FAILED;
        (bool decoded, address validator, bytes memory validatorSignature) = _tryDecodeSignature(userOp.signature);
        if (!decoded) return ValidationDataLib.SIG_VALIDATION_FAILED;
        if (!_modules[ModuleType.VALIDATOR][validator]) return ValidationDataLib.SIG_VALIDATION_FAILED;
        try ILoomValidator(validator)
            .validateUserOp(
                address(this),
                userOpHash,
                userOp.nonce,
                validatorSignature,
                userOp.callData,
                _paymaster(userOp.paymasterAndData)
            ) returns (
            uint256 result
        ) {
            validationData = result;
        } catch {
            validationData = ValidationDataLib.SIG_VALIDATION_FAILED;
        }
        if (missingAccountFunds != 0) {
            // Best-effort EntryPoint prefund. The EntryPoint enforces sufficient
            // payment and reverts the operation if this account underpays, so the
            // transfer result is intentionally not asserted here.
            (bool sent,) = payable(msg.sender).call{value: missingAccountFunds}("");
            sent;
        }
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (bool decoded, address validator, bytes memory validatorSignature) = _tryDecodeSignature(signature);
        if (!decoded) return ERC1271_INVALID;
        if (!_modules[ModuleType.VALIDATOR][validator]) return ERC1271_INVALID;
        try ILoomValidator(validator).isValidSignature(address(this), hash, validatorSignature) returns (bool valid) {
            return valid ? ERC1271_MAGIC_VALUE : ERC1271_INVALID;
        } catch {
            return ERC1271_INVALID;
        }
    }

    // --- Execution ---
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable nonReentrantExecution {
        if (msg.sender != entryPoint && msg.sender != address(this)) revert OnlyEntryPoint();
        _executeAuthorized(mode, executionCalldata, msg.sender, msg.data);
    }

    /// @notice Executes a validator-authorized operation without going through
    /// the EntryPoint or any bundler.
    /// @dev This is the constitution's independently executable account-control
    /// path: if every bundler censors or 4337 infrastructure is unavailable,
    /// any EOA can still submit this transaction and the account remains
    /// controllable. Authorization is identical in strength to the 4337 path
    /// (an installed validator signs an EIP-712 digest bound to this account,
    /// nonce, config version, and expiry); only the transport differs.
    function executeDirect(
        address validator,
        bytes32 mode,
        bytes calldata executionCalldata,
        uint48 validUntil,
        bytes calldata signature
    ) external payable nonReentrantExecution {
        // forge-lint: disable-next-line(block-timestamp)
        if (validUntil < block.timestamp || !_modules[ModuleType.VALIDATOR][validator]) {
            revert InvalidDirectExecution();
        }
        uint256 nonce = directExecutionNonces[validator]++;
        bytes32 executionHash = directExecutionDigest(validator, mode, executionCalldata, nonce, validUntil);
        bytes memory accountCall = abi.encodeCall(this.execute, (mode, executionCalldata));
        try ILoomDirectValidator(validator)
            .validateDirectExecution(address(this), executionHash, signature, accountCall) returns (
            bool valid
        ) {
            if (!valid) revert InvalidDirectExecution();
        } catch {
            revert InvalidDirectExecution();
        }
        _executeAuthorized(mode, executionCalldata, msg.sender, accountCall);
        emit DirectExecution(validator, nonce, executionHash);
    }

    function directExecutionDigest(
        address validator,
        bytes32 mode,
        bytes calldata executionCalldata,
        uint256 nonce,
        uint48 validUntil
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                DIRECT_EXECUTION_TYPEHASH,
                validator,
                mode,
                keccak256(executionCalldata),
                nonce,
                configVersion,
                validUntil
            )
        );
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function _executeAuthorized(
        bytes32 mode,
        bytes calldata executionCalldata,
        address caller,
        bytes memory accountCall
    ) internal {
        if (mode != SINGLE_EXECUTION_MODE && mode != BATCH_EXECUTION_MODE) {
            revert UnsupportedExecutionMode();
        }
        (bytes1 callType,) = ExecutionLib.mode(mode);
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil && !_isFrozenSafe(callType, executionCalldata)) revert AccountFrozen();

        bool bypassHooks = _isHookRecoverySchedule(callType, executionCalldata);
        address[] memory checkedHooks = new address[](0);
        bytes[] memory hookData = new bytes[](0);
        if (!bypassHooks) (checkedHooks, hookData) = _preCheck(caller, accountCall);
        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            _execute(abi.decode(executionCalldata, (ExecutionLib.Execution)));
        } else if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory executions = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            if (executions.length == 0) revert EmptyBatch();
            for (uint256 i; i < executions.length; ++i) {
                _execute(executions[i]);
            }
        } else {
            revert UnsupportedExecutionMode();
        }
        if (!bypassHooks) _postCheck(checkedHooks, hookData);
    }

    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        return mode == SINGLE_EXECUTION_MODE || mode == BATCH_EXECUTION_MODE;
    }

    function accountId() external pure returns (string memory) {
        return "loom.account";
    }

    function supportsModule(uint256 moduleTypeId) external pure returns (bool) {
        return
            moduleTypeId == ModuleType.VALIDATOR || moduleTypeId == ModuleType.HOOK
                || moduleTypeId == ModuleType.RECOVERY;
    }

    function executeFromExecutor(bytes32, bytes calldata) external pure returns (bytes[] memory) {
        revert UnsupportedModuleType();
    }

    // --- Module installation ---
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external onlyScheduledSelf {
        _installModule(moduleTypeId, module, initData);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        onlyScheduledSelf
    {
        _uninstallModule(moduleTypeId, module, deInitData);
        _advanceConfig(keccak256(abi.encode("MODULE_UNINSTALLED", moduleTypeId, module)));
    }

    // --- Recovery (module-driven authority replacement) ---
    function recoverConfiguration(
        address[] calldata oldValidators,
        address newValidator,
        bytes calldata initData,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external nonReentrantExecution {
        if (!_modules[ModuleType.RECOVERY][msg.sender]) revert InvalidModule();
        _validateCompleteValidatorSet(oldValidators);
        if (
            _modules[ModuleType.VALIDATOR][newValidator] || newValidator.code.length == 0
                || !ILoomModule(newValidator).isModuleType(ModuleType.VALIDATOR)
        ) revert InvalidModule();
        _validateRecoveryGuardianConfig(newGuardianRoot, newGuardianThreshold);
        guardianRoot = newGuardianRoot;
        guardianThreshold = newGuardianThreshold;
        emit GuardianConfigUpdated(newGuardianRoot, newGuardianThreshold);
        for (uint256 i; i < oldValidators.length; ++i) {
            _removeValidatorForRecovery(oldValidators[i]);
        }
        _installModule(ModuleType.VALIDATOR, newValidator, initData);
        _advanceConfig(
            keccak256(
                abi.encode(
                    CONFIGURATION_RECOVERED_HASH,
                    keccak256(abi.encode(oldValidators)),
                    newValidator,
                    keccak256(initData),
                    newGuardianRoot,
                    newGuardianThreshold
                )
            )
        );
    }

    function recoverConfigurationSet(
        address[] calldata oldValidators,
        ILoomAccount.RecoveryModuleInit[] calldata newValidators,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external nonReentrantExecution {
        if (!_modules[ModuleType.RECOVERY][msg.sender]) revert InvalidModule();
        _validateCompleteValidatorSet(oldValidators);
        _validateNewValidatorSet(newValidators);
        _validateRecoveryGuardianConfig(newGuardianRoot, newGuardianThreshold);

        guardianRoot = newGuardianRoot;
        guardianThreshold = newGuardianThreshold;
        emit GuardianConfigUpdated(newGuardianRoot, newGuardianThreshold);

        for (uint256 i; i < oldValidators.length; ++i) {
            _removeValidatorForRecovery(oldValidators[i]);
        }
        for (uint256 i; i < newValidators.length; ++i) {
            _installModule(ModuleType.VALIDATOR, newValidators[i].module, newValidators[i].initData);
        }
        _advanceConfig(
            keccak256(
                abi.encode(
                    CONFIGURATION_SET_RECOVERED_HASH,
                    keccak256(abi.encode(oldValidators)),
                    keccak256(abi.encode(newValidators)),
                    newGuardianRoot,
                    newGuardianThreshold
                )
            )
        );
    }

    function _uninstallModule(uint256 moduleTypeId, address module, bytes memory deInitData) internal {
        if (!_modules[moduleTypeId][module]) revert InvalidModule();
        if (moduleTypeId == ModuleType.VALIDATOR && _validatorCount == 1) revert InvalidModule();
        _modules[moduleTypeId][module] = false;
        if (moduleTypeId == ModuleType.VALIDATOR) --_validatorCount;
        if (moduleTypeId == ModuleType.RECOVERY) --_recoveryModuleCount;
        if (moduleTypeId == ModuleType.HOOK) _removeFromArray(_hooks, module);
        if (moduleTypeId == ModuleType.VALIDATOR) _removeFromArray(_validators, module);
        if (deInitData.length != 0) {
            (bool ok, bytes memory result) = module.call(deInitData);
            if (!ok) revert CallFailed(result);
        }
        emit ModuleUninstalled(moduleTypeId, module);
    }

    function _removeValidatorForRecovery(address module) internal {
        if (!_modules[ModuleType.VALIDATOR][module]) revert InvalidModule();
        _modules[ModuleType.VALIDATOR][module] = false;
        --_validatorCount;
        _removeFromArray(_validators, module);
        emit ModuleUninstalled(ModuleType.VALIDATOR, module);
    }

    /// @dev Removes the first occurrence of `value` from `array` with a swap-and-pop.
    /// Order is not preserved, which is fine for the validator and hook sets.
    function _removeFromArray(address[] storage array, address value) internal {
        uint256 length = array.length;
        for (uint256 i; i < length; ++i) {
            if (array[i] == value) {
                array[i] = array[length - 1];
                array.pop();
                break;
            }
        }
    }

    /// @dev Authoritative in-storage enforcement of the rules that
    /// ValidatorSetLib pre-checks module-side; keep the two in sync.
    function _validateCompleteValidatorSet(address[] calldata validators) internal view {
        if (validators.length == 0 || validators.length != _validatorCount) revert InvalidModule();
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            address validator = validators[i];
            if (validator <= previous || !_modules[ModuleType.VALIDATOR][validator]) revert InvalidModule();
            previous = validator;
        }
    }

    function _validateNewValidatorSet(ILoomAccount.RecoveryModuleInit[] calldata validators) internal view {
        if (validators.length == 0 || validators.length > MAX_VALIDATORS) revert InvalidModule();
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            ILoomAccount.RecoveryModuleInit calldata validator = validators[i];
            if (
                validator.moduleTypeId != ModuleType.VALIDATOR || validator.module <= previous
                    || validator.module.code.length == 0 || _modules[ModuleType.VALIDATOR][validator.module]
                    || !ILoomModule(validator.module).isModuleType(ModuleType.VALIDATOR)
            ) revert InvalidModule();
            previous = validator.module;
        }
    }

    function _validateRecoveryGuardianConfig(bytes32 newGuardianRoot, uint8 newGuardianThreshold) internal view {
        if (
            newGuardianRoot == bytes32(0) || newGuardianRoot == guardianRoot || newGuardianThreshold == 0
                || newGuardianThreshold > MAX_GUARDIAN_THRESHOLD
        ) revert InvalidModule();
    }

    // --- Module and validator views ---
    function isModuleInstalled(uint256 moduleTypeId, address module) external view returns (bool) {
        return _modules[moduleTypeId][module];
    }

    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata) external view returns (bool) {
        return _modules[moduleTypeId][module];
    }

    function validatorCount() external view returns (uint256) {
        return _validatorCount;
    }

    function validatorAt(uint256 index) external view returns (address) {
        return _validators[index];
    }

    // --- Guardian configuration and freeze ---
    function setGuardianConfig(bytes32 newRoot, uint8 newThreshold) external onlyScheduledSelf {
        if (!_validProtectedGuardianConfig(newRoot, newThreshold)) {
            revert InvalidGuardianConfig();
        }
        guardianRoot = newRoot;
        guardianThreshold = newThreshold;
        emit GuardianConfigUpdated(newRoot, newThreshold);
        _advanceConfig(keccak256(abi.encode("GUARDIANS_UPDATED", newRoot, newThreshold)));
    }

    function recoveryConfigured() external view returns (bool) {
        return _recoveryConfigured();
    }

    function notifyConfigChange(bytes32 changeHash) external {
        if (!_modules[ModuleType.VALIDATOR][msg.sender] && !_modules[ModuleType.HOOK][msg.sender]) {
            revert InvalidModule();
        }
        if (!_executingScheduled) revert OperationNotReady();
        _advanceConfig(changeHash);
    }

    function guardianLeaf(address verifier, bytes32 keyCommitment, bytes32 salt) public view returns (bytes32) {
        return GuardianVerificationLib.guardianLeaf(verifier, keyCommitment, salt);
    }

    function freeze(
        address verifier,
        bytes32 keyCommitment,
        bytes32 salt,
        bytes32[] calldata proof,
        bytes calldata signature
    ) external {
        if (verifier.code.length == 0 || keyCommitment == bytes32(0)) revert InvalidModule();
        if (proof.length > MAX_GUARDIAN_PROOF_LENGTH) revert InvalidModule();
        bytes32 leaf = guardianLeaf(verifier, keyCommitment, salt);
        if (!MerkleProof.verify(proof, guardianRoot, leaf)) revert InvalidModule();
        if (lastFreezeConfigVersion[leaf] == configVersion) revert InvalidModule();
        bytes32 structHash = keccak256(abi.encode(FREEZE_TYPEHASH, leaf, freezeNonces[leaf], configVersion));
        bytes32 digest = EIP712Lib.digest(_domainSeparator(), structHash);
        try IGuardianVerifier(verifier).verify(keyCommitment, digest, signature) returns (bool valid) {
            if (!valid) revert InvalidModule();
        } catch {
            revert InvalidModule();
        }
        ++freezeNonces[leaf];
        lastFreezeConfigVersion[leaf] = configVersion;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 until = uint48(block.timestamp) + FREEZE_DURATION;
        if (until > frozenUntil) frozenUntil = until;
        emit Frozen(frozenUntil);
    }

    function unfreeze() external onlySelf {
        // A compromised primary validator must not be able to defeat a
        // guardian's emergency window. The freeze expires permissionlessly.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil) revert FreezeActive();
        frozenUntil = 0;
        emit Frozen(0);
    }

    function isExecutingScheduled() external view returns (bool) {
        return _executingScheduled;
    }

    // --- Timelocked call scheduling ---
    function scheduleCall(address target, uint256 value, bytes calldata data, uint48 delay)
        external
        onlySelf
        returns (bytes32 operationId)
    {
        uint48 minimum = target == address(this) || _modules[ModuleType.VALIDATOR][target]
            || _modules[ModuleType.HOOK][target] || _modules[ModuleType.RECOVERY][target]
            ? MIN_CONFIG_DELAY
            : MIN_EXTERNAL_DELAY;
        if (delay < minimum || delay > MAX_SCHEDULE_DELAY) revert InvalidDelay();
        operationId = keccak256(abi.encode(target, value, data, configVersion));
        if (scheduledOperations[operationId] != 0) revert OperationAlreadyScheduled();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 readyAt = uint48(block.timestamp) + delay;
        scheduledOperations[operationId] = readyAt;
        emit OperationScheduled(operationId, readyAt);
    }

    function cancelScheduled(bytes32 operationId) external onlySelf {
        if (scheduledOperations[operationId] == 0) revert OperationNotScheduled();
        delete scheduledOperations[operationId];
        emit OperationCancelled(operationId);
    }

    // --- Sovereign migration ---
    function scheduleMigration(
        address destination,
        bytes32 destinationCodeHash,
        bytes32 destinationConfigHash,
        bytes32 callsHash,
        uint48 delay,
        uint48 executionWindow
    ) external onlySelf returns (bytes32 migrationId) {
        if (pendingMigration.readyAt != 0) revert MigrationAlreadyPending();
        if (
            destination == address(0) || destination == address(this) || destinationCodeHash == bytes32(0)
                || destination.code.length == 0 || destination.codehash != destinationCodeHash
                || callsHash == bytes32(0) || delay < MIN_CONFIG_DELAY || executionWindow == 0
                || executionWindow > MAX_MIGRATION_WINDOW
        ) revert InvalidMigration();
        if (destinationConfigHash != bytes32(0) && ILoomAccount(destination).configHash() != destinationConfigHash) {
            revert InvalidMigration();
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 readyAt = uint48(block.timestamp) + delay;
        uint48 expiresAt = readyAt + executionWindow;
        pendingMigration = PendingMigration({
            destination: destination,
            destinationCodeHash: destinationCodeHash,
            destinationConfigHash: destinationConfigHash,
            callsHash: callsHash,
            readyAt: readyAt,
            expiresAt: expiresAt,
            configVersion: configVersion,
            nonce: migrationNonce
        });
        migrationId = migrationIdFor(pendingMigration);
        emit MigrationScheduled(
            migrationId, destination, destinationCodeHash, destinationConfigHash, callsHash, readyAt, expiresAt
        );
    }

    function cancelMigration() external onlySelf {
        PendingMigration memory migration = pendingMigration;
        if (migration.readyAt == 0) revert MigrationNotPending();
        _cancelMigration(migration);
    }

    function cancelMigrationWithGuardians(GuardianVerificationLib.Approval[] calldata guardianApprovals) external {
        PendingMigration memory migration = pendingMigration;
        if (migration.readyAt == 0) revert MigrationNotPending();
        bytes32 migrationId = migrationIdFor(migration);
        bytes32 digest = migrationCancelDigest(migrationId, migration.configVersion, migration.nonce);
        if (!GuardianVerificationLib.approved(guardianRoot, guardianThreshold, digest, guardianApprovals)) {
            revert InvalidModule();
        }
        _cancelMigration(migration);
    }

    function migrationCancelDigest(bytes32 migrationId, uint64 version, uint64 nonce) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(CANCEL_MIGRATION_TYPEHASH, migrationId, version, nonce));
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    // Hooks gate every unscheduled execute()/executeDirect() call. A hook that
    // reverts or never returns blocks all ordinary fund movement until the
    // scheduled removal path clears MIN_CONFIG_DELAY. The guardian threshold
    // can evict a hook immediately instead, since reaching threshold consensus
    // to remove (never install) a hook is itself the security bar - this
    // mirrors cancelMigrationWithGuardians, which is also immediate.
    function evictHookWithGuardians(address hook, GuardianVerificationLib.Approval[] calldata guardianApprovals)
        external
    {
        bytes32 digest = evictHookDigest(hook, configVersion);
        if (!GuardianVerificationLib.approved(guardianRoot, guardianThreshold, digest, guardianApprovals)) {
            revert InvalidModule();
        }
        _uninstallModule(ModuleType.HOOK, hook, "");
        _advanceConfig(keccak256(abi.encode("HOOK_EVICTED_BY_GUARDIANS", hook)));
    }

    function evictHookDigest(address hook, uint64 version) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EVICT_HOOK_TYPEHASH, hook, version));
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function _cancelMigration(PendingMigration memory migration) internal {
        bytes32 migrationId = migrationIdFor(migration);
        delete pendingMigration;
        ++migrationNonce;
        emit MigrationCancelled(migrationId);
    }

    function executeMigration(ExecutionLib.Execution[] calldata calls) external nonReentrantExecution {
        PendingMigration memory migration = pendingMigration;
        if (migration.readyAt == 0 || keccak256(abi.encode(calls)) != migration.callsHash) {
            revert InvalidMigration();
        }
        if (calls.length == 0) revert EmptyBatch();
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil) revert AccountFrozen();
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < migration.readyAt) revert OperationNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > migration.expiresAt || configVersion != migration.configVersion) {
            revert InvalidMigration();
        }
        if (migration.destination.codehash != migration.destinationCodeHash) revert InvalidMigration();
        if (
            migration.destinationConfigHash != bytes32(0)
                && ILoomAccount(migration.destination).configHash() != migration.destinationConfigHash
        ) {
            revert InvalidMigration();
        }
        bytes32 migrationId = migrationIdFor(migration);
        delete pendingMigration;
        ++migrationNonce;

        bytes memory executionCalldata = abi.encode(calls);
        bytes memory accountCall = abi.encodeCall(this.execute, (BATCH_EXECUTION_MODE, executionCalldata));
        (address[] memory checkedHooks, bytes[] memory hookData) = _preCheck(msg.sender, accountCall);
        for (uint256 i; i < calls.length; ++i) {
            _execute(calls[i]);
        }
        _postCheck(checkedHooks, hookData);
        emit MigrationExecuted(migrationId, migration.destination);
    }

    function migrationIdFor(PendingMigration memory migration) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(this),
                migration.destination,
                migration.destinationCodeHash,
                migration.destinationConfigHash,
                migration.callsHash,
                migration.readyAt,
                migration.expiresAt,
                migration.configVersion,
                migration.nonce,
                block.chainid
            )
        );
    }

    // --- Scheduled execution and allowance revocation ---
    function executeScheduled(address target, uint256 value, bytes calldata data) external nonReentrantExecution {
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil) revert AccountFrozen();
        bytes32 operationId = keccak256(abi.encode(target, value, data, configVersion));
        uint48 readyAt = scheduledOperations[operationId];
        if (readyAt == 0) revert OperationNotScheduled();
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < readyAt) revert OperationNotReady();
        delete scheduledOperations[operationId];
        _executingScheduled = true;
        bool bypassHooks = _isHookRemovalExecution(target, value, data);
        address[] memory checkedHooks = new address[](0);
        bytes[] memory hookData = new bytes[](0);
        if (!bypassHooks) (checkedHooks, hookData) = _preCheck(msg.sender, msg.data);
        _execute(ExecutionLib.Execution(target, value, data));
        if (!bypassHooks) _postCheck(checkedHooks, hookData);
        _executingScheduled = false;
        emit OperationExecuted(operationId);
    }

    function revokeTokenAllowance(address token, address spender) external onlySelf {
        if (token.code.length == 0 || spender == address(0)) revert InvalidTokenAllowance();
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, 0));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert CallFailed(result);
        emit AllowanceRevoked(token, spender);
    }

    // --- Internal helpers ---
    function _installModule(uint256 moduleTypeId, address module, bytes memory initData) internal {
        if (
            moduleTypeId != ModuleType.VALIDATOR && moduleTypeId != ModuleType.HOOK
                && moduleTypeId != ModuleType.RECOVERY || module.code.length == 0
                || !ILoomModule(module).isModuleType(moduleTypeId)
        ) revert UnsupportedModuleType();
        if (_modules[moduleTypeId][module]) revert InvalidModule();
        if (moduleTypeId == ModuleType.VALIDATOR && _validatorCount >= MAX_VALIDATORS) revert ModuleLimitReached();
        if (moduleTypeId == ModuleType.HOOK && _hooks.length >= MAX_HOOKS) revert ModuleLimitReached();
        if (moduleTypeId == ModuleType.RECOVERY && _recoveryModuleCount >= MAX_RECOVERY_MODULES) {
            revert ModuleLimitReached();
        }
        _modules[moduleTypeId][module] = true;
        if (moduleTypeId == ModuleType.VALIDATOR) {
            ++_validatorCount;
            _validators.push(module);
        }
        if (moduleTypeId == ModuleType.HOOK) _hooks.push(module);
        if (moduleTypeId == ModuleType.RECOVERY) ++_recoveryModuleCount;
        if (initData.length != 0) {
            (bool ok, bytes memory result) = module.call(initData);
            if (!ok) revert CallFailed(result);
        }
        emit ModuleInstalled(moduleTypeId, module);
        if (_executingScheduled) _advanceConfig(keccak256(abi.encode("MODULE_INSTALLED", moduleTypeId, module)));
    }

    function _initialize(
        address entryPoint_,
        bytes32 guardianRoot_,
        uint8 guardianThreshold_,
        bytes32 configHash_,
        ModuleInit[] memory modules
    ) internal {
        if (configVersion != 0 || entryPoint_.code.length == 0 || configHash_ == bytes32(0) || modules.length == 0) {
            revert InvalidInitialization();
        }
        if (!_validInitialGuardianConfig(guardianRoot_, guardianThreshold_)) {
            revert InvalidGuardianConfig();
        }
        entryPoint = entryPoint_;
        guardianRoot = guardianRoot_;
        guardianThreshold = guardianThreshold_;
        configHash = configHash_;
        configVersion = 1;
        for (uint256 i; i < modules.length; ++i) {
            _installModule(modules[i].moduleTypeId, modules[i].module, modules[i].initData);
        }
        if (_validatorCount == 0) revert InvalidGuardianConfig();
        emit ConfigUpdated(configHash_, 1);
        emit GuardianConfigUpdated(guardianRoot_, guardianThreshold_);
    }

    function _validInitialGuardianConfig(bytes32 root, uint8 threshold) internal pure returns (bool) {
        return (root == bytes32(0) && threshold == 0) || _validProtectedGuardianConfig(root, threshold);
    }

    function _validProtectedGuardianConfig(bytes32 root, uint8 threshold) internal pure returns (bool) {
        return root != bytes32(0) && threshold != 0 && threshold <= MAX_GUARDIAN_THRESHOLD;
    }

    function _recoveryConfigured() internal view returns (bool) {
        return guardianRoot != bytes32(0) && guardianThreshold != 0;
    }

    function _advanceConfig(bytes32 changeHash) internal {
        configHash = keccak256(abi.encode(configHash, changeHash));
        ++configVersion;
        emit ConfigUpdated(configHash, configVersion);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return EIP712Lib.domainSeparator(NAME_HASH, VERSION_HASH);
    }

    function decodeSignature(bytes calldata signature)
        external
        pure
        returns (address validator, bytes memory validatorSignature)
    {
        return abi.decode(signature, (address, bytes));
    }

    function decodeScheduleCall(bytes calldata data)
        external
        pure
        returns (address target, uint256 value, bytes memory callData, uint48 delay)
    {
        return abi.decode(data[4:], (address, uint256, bytes, uint48));
    }

    function _tryDecodeSignature(bytes calldata signature)
        internal
        view
        returns (bool decoded, address validator, bytes memory validatorSignature)
    {
        try this.decodeSignature(signature) returns (address decodedValidator, bytes memory decodedSignature) {
            return (true, decodedValidator, decodedSignature);
        } catch {
            return (false, address(0), bytes(""));
        }
    }

    function _preCheck(address caller, bytes memory accountCall)
        internal
        returns (address[] memory checkedHooks, bytes[] memory hookData)
    {
        checkedHooks = _hooks;
        hookData = new bytes[](checkedHooks.length);
        for (uint256 i; i < checkedHooks.length; ++i) {
            hookData[i] = ILoomHook(checkedHooks[i]).preCheck(address(this), caller, accountCall);
        }
    }

    function _postCheck(address[] memory checkedHooks, bytes[] memory hookData) internal {
        for (uint256 i; i < checkedHooks.length; ++i) {
            ILoomHook(checkedHooks[i]).postCheck(address(this), hookData[i]);
        }
    }

    function _execute(ExecutionLib.Execution memory execution) internal {
        if (execution.target == address(0)) revert CallFailed("");
        // A smart account must be able to send authorized ETH to arbitrary targets.
        // slither-disable-next-line arbitrary-send-eth
        (bool ok, bytes memory result) = execution.target.call{value: execution.value}(execution.callData);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function _isFrozenSafe(bytes1 callType, bytes calldata executionCalldata) internal view returns (bool) {
        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            return _isRecoveryExecution(abi.decode(executionCalldata, (ExecutionLib.Execution)));
        }
        if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory executions = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            for (uint256 i; i < executions.length; ++i) {
                if (!_isRecoveryExecution(executions[i])) return false;
            }
            return true;
        }
        return false;
    }

    function _isRecoveryExecution(ExecutionLib.Execution memory execution) internal view returns (bool) {
        if (execution.callData.length < 4) return false;
        bytes4 selector;
        bytes memory callData = execution.callData;
        assembly {
            selector := mload(add(callData, 32))
        }
        if (!_modules[ModuleType.RECOVERY][execution.target]) return false;
        if (selector != CANCEL_RECOVERY || callData.length != 36 || execution.value != 0) return false;
        address recoveryAccount;
        assembly {
            recoveryAccount := mload(add(callData, 36))
        }
        return recoveryAccount == address(this);
    }

    function _isHookRecoverySchedule(bytes1 callType, bytes calldata executionCalldata) internal view returns (bool) {
        if (callType != ExecutionLib.CALLTYPE_SINGLE) return false;
        ExecutionLib.Execution memory execution = abi.decode(executionCalldata, (ExecutionLib.Execution));
        if (execution.target != address(this) || execution.callData.length < 4) return false;
        bytes4 selector = _selector(execution.callData);
        if (selector != this.scheduleCall.selector) return false;

        try this.decodeScheduleCall(execution.callData) returns (
            address target, uint256 value, bytes memory callData, uint48
        ) {
            return _isHookRemovalExecution(target, value, callData);
        } catch {
            return false;
        }
    }

    function _isHookRemovalExecution(address target, uint256 value, bytes memory callData)
        internal
        view
        returns (bool)
    {
        if (
            target != address(this) || value != 0
                || callData.length < UNINSTALL_MODULE_MIN_SELECTOR_AND_STATIC_ARGS_SIZE
                || _selector(callData) != this.uninstallModule.selector
        ) return false;
        uint256 moduleTypeId;
        address module;
        assembly {
            moduleTypeId := mload(add(callData, 36))
            module := mload(add(callData, 68))
        }
        return moduleTypeId == ModuleType.HOOK && _modules[ModuleType.HOOK][module];
    }

    function _selector(bytes memory callData) internal pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(callData, 32))
        }
    }

    function _paymaster(bytes calldata paymasterAndData) internal pure returns (address paymaster) {
        if (paymasterAndData.length < 20) return address(0);
        assembly {
            paymaster := shr(96, calldataload(paymasterAndData.offset))
        }
    }
}
