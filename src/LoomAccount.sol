// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC1271} from "./interfaces/IERC1271.sol";
import {ILoomAccount} from "./interfaces/ILoomAccount.sol";
import {ILoomDirectValidator} from "./interfaces/ILoomDirectValidator.sol";
import {ILoomHook} from "./interfaces/ILoomHook.sol";
import {ILoomModule} from "./interfaces/ILoomModule.sol";
import {ILoomValidator} from "./interfaces/ILoomValidator.sol";
import {IGuardianVerifier} from "./interfaces/IGuardianVerifier.sol";
import {ILoomPolicyBoundValidator} from "./interfaces/ILoomPolicyBoundValidator.sol";
import {MigrationModule} from "./MigrationModule.sol";
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
    error InvalidInitializationContext();
    error Reentrancy();
    error ModuleLimitReached();
    error InvalidTokenAllowance();
    error EmptyBatch();
    error InvalidBatch();
    error BatchLimitExceeded();
    error ReturnDataLimitExceeded(uint256 size);
    error FreezeActive();
    error InvalidDirectExecution();
    error OperationAlreadyScheduled();
    error OperationExpired();

    // --- Types ---
    struct ModuleInit {
        uint256 moduleTypeId;
        address module;
        bytes initData;
    }

    /// @notice A scheduled call's readiness window and instance counter.
    /// @dev `operationId` identifies a call shape at a configuration version, so
    /// the same call scheduled again reuses this slot. `nonce` distinguishes the
    /// current occupant from every previous one, which is what a guardian
    /// cancellation approval binds; without it a revealed approval would stay valid
    /// for every future occupant of the slot. Consumption clears `readyAt` and
    /// advances `nonce` rather than deleting the entry, so the counter survives in
    /// the slot it describes. `readyAt == 0` remains the "not scheduled" test.
    struct ScheduledOperation {
        uint48 readyAt;
        uint48 expiresAt;
        uint64 nonce;
    }

    // --- Constants ---
    /// @notice Minimum schedule delay for calls to external targets.
    /// @dev Configuration targets (the account itself or an installed module)
    /// use the longer MIN_CONFIG_DELAY; see scheduleCall.
    uint48 public constant MIN_EXTERNAL_DELAY = 1 days;
    uint48 public constant MIN_CONFIG_DELAY = 3 days;
    /// @notice How long a guardian freeze holds.
    /// @dev Must cover the whole recovery path, not just its start. A guardian who
    /// freezes the instant an attack is noticed also needs `RecoveryManager`'s
    /// `RECOVERY_DELAY` to pass before recovery is executable, plus room to publish
    /// that execution. At two days this was shorter than the three-day recovery
    /// delay, so the freeze lapsed roughly a day before recovery could replace the
    /// compromised validator -- and `MIN_EXTERNAL_DELAY` is one day, so an operation
    /// scheduled before the freeze was already ready and waiting in that window,
    /// executable permissionlessly by the attacker.
    ///
    /// Recovery execution is not blocked by the freeze: `recoverConfiguration` is
    /// gated on the recovery module, not on `frozenUntil`. Lengthening the freeze
    /// therefore delays nothing legitimate.
    uint48 public constant FREEZE_DURATION = 5 days;
    uint48 public constant MAX_SCHEDULE_DELAY = 90 days;
    /// @notice How long a scheduled call stays executable after it becomes ready.
    /// @dev Every other delayed mechanism here already bounds its window --
    /// `RECOVERY_WINDOW`, `SYNC_WINDOW`, `MAX_WITHDRAWAL_WINDOW`,
    /// `MAX_MIGRATION_WINDOW`. Generic scheduled calls were the one exception: they
    /// stored only `readyAt`, so once ready they stayed executable forever unless an
    /// unrelated configuration change happened to invalidate them. That let an
    /// attacker park a ready operation indefinitely and publish it at the moment it
    /// was least defensible, since `executeScheduled` is permissionless.
    uint48 public constant SCHEDULE_WINDOW = 30 days;
    uint256 public constant MAX_VALIDATORS = ValidatorSetLib.MAX_VALIDATORS;
    uint256 public constant MAX_HOOKS = 8;
    uint256 public constant MAX_BATCH_SIZE = 32;
    uint256 public constant MAX_REVERT_DATA_LENGTH = 2_048;
    uint256 public constant MAX_RECOVERY_MODULES = 1;
    uint8 public constant MAX_GUARDIAN_THRESHOLD = GuardianVerificationLib.MAX_GUARDIAN_THRESHOLD;
    /// @dev `freeze` verifies a guardian proof itself rather than through
    /// `GuardianVerificationLib.approved`, which is the only guardian path that
    /// does. Taking the bound from the library rather than restating the literal
    /// keeps the two from drifting: a proof length the library rejects for a
    /// recovery approval must not be accepted for a freeze.
    uint256 public constant MAX_GUARDIAN_PROOF_LENGTH = GuardianVerificationLib.MAX_PROOF_LENGTH;
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
    bytes32 public constant DIRECT_EXECUTION_TYPEHASH = keccak256(
        "DirectExecution(address validator,bytes32 mode,bytes32 executionCalldataHash,uint256 nonce,uint64 configVersion,uint48 validUntil)"
    );
    bytes32 public constant EVICT_HOOK_TYPEHASH =
        keccak256("EvictHook(address hook,address replacement,uint64 configVersion)");
    bytes32 public constant CANCEL_SCHEDULED_TYPEHASH =
        keccak256("CancelScheduled(bytes32 operationId,uint64 configVersion,uint64 nonce)");
    bytes32 private constant NAME_HASH = keccak256("LoomAccount");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CONFIGURATION_RECOVERED_HASH = keccak256("CONFIGURATION_RECOVERED");
    bytes32 private constant CONFIGURATION_SET_RECOVERED_HASH = keccak256("CONFIGURATION_SET_RECOVERED");
    bytes32 private constant FROZEN_RECOVERY_CANCELLED_HASH = keccak256("FROZEN_RECOVERY_CANCELLED");
    bytes4 private constant CANCEL_RECOVERY =
        bytes4(keccak256("cancelRecoveryWithAccountAndGuardians(address,(address,bytes32,bytes32,bytes,bytes32[])[])"));
    uint256 private constant CANCEL_RECOVERY_MIN_SELECTOR_AND_STATIC_ARGS_SIZE = 100;
    uint256 private constant UNINSTALL_MODULE_MIN_SELECTOR_AND_STATIC_ARGS_SIZE = 100;

    // --- Storage (pinned for this deployment generation) ---
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
    mapping(bytes32 operationId => ScheduledOperation) public scheduledOperations;
    mapping(bytes32 guardianLeaf => uint256) public freezeNonces;
    mapping(bytes32 guardianLeaf => uint64) public lastFreezeConfigVersion;
    bool private _executingScheduled;
    bool private _executionLocked;
    address public migrationModule;

    // --- Events ---
    event ModuleInstalled(uint256 indexed moduleTypeId, address indexed module);
    event ModuleUninstalled(uint256 indexed moduleTypeId, address indexed module);
    event ConfigUpdated(bytes32 indexed configHash, uint64 indexed configVersion);
    event GuardianConfigUpdated(bytes32 indexed guardianRoot, uint8 guardianThreshold);
    event Frozen(uint48 frozenUntil);
    event OperationScheduled(bytes32 indexed operationId, uint48 readyAt, uint48 expiresAt, uint64 nonce);
    event OperationCancelled(bytes32 indexed operationId);
    event OperationExecuted(bytes32 indexed operationId);
    event AllowanceRevoked(address indexed token, address indexed spender);
    event DirectExecution(address indexed validator, uint256 indexed nonce, bytes32 indexed executionHash);

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

    /// @notice Immutable-proxy bootstrap entry point. Callable only from a
    /// `LoomAccountProxy` constructor, never by a third party.
    /// @dev `LoomAccountProxy` delegatecalls this from its own constructor, where
    /// `address(this)` is the proxy under construction and therefore still has no
    /// code. That makes "no code at `address(this)`" an exact discriminator for the
    /// one legitimate caller, and it is why this initializer cannot simply require
    /// `msg.sender == address(this)`: during proxy construction the caller is the
    /// factory.
    ///
    /// Every other context is rejected. In particular an EIP-7702 delegated EOA
    /// carries the 23-byte `0xef0100 || template` delegation indicator as its code,
    /// so it can never reach `_initialize` through this function. Delegated accounts
    /// must use `initializeDelegatedAccount`, which requires the EOA itself to send
    /// the transaction and therefore to authorize the exact initialization payload
    /// with its own key, replay-protected by its own nonce and bound to the chain by
    /// the transaction's chain id.
    ///
    /// Without this guard an uninitialized delegated EOA has `configVersion == 0`,
    /// so any third party could install an attacker-chosen EntryPoint, validator
    /// set, hooks, and guardian configuration and then drain the account.
    ///
    /// A deployed runtime template is covered by the same check, since it has code.
    /// The permitted context cannot be reached by an external call at all: an account
    /// under construction has no code, so a call to it dispatches no runtime and
    /// returns success without executing anything. Only the proxy constructor's own
    /// delegatecall runs this function there, atomically with deployment.
    function initialize(
        address entryPoint_,
        bytes32 guardianRoot_,
        uint8 guardianThreshold_,
        bytes32 configHash_,
        ModuleInit[] calldata modules
    ) external payable {
        if (address(this).code.length != 0) {
            revert InvalidInitializationContext();
        }
        _initialize(entryPoint_, guardianRoot_, guardianThreshold_, configHash_, modules);
    }

    /// @notice EIP-7702 initialization entry point for a delegated EOA.
    /// @dev `msg.sender == address(this)` means the delegated EOA itself sent the
    /// transaction, so the EOA key authorizes this exact payload. The EOA's own
    /// transaction nonce provides replay protection and the transaction's chain id
    /// provides chain separation; no separate signature envelope is required.
    /// One-shot: `_initialize` rejects any account whose `configVersion != 0`.
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

    // --- Caller authorization ---
    /// @dev The one predicate that answers "may this caller use the shared
    /// execution surface". It deliberately does not authorize an
    /// environment-specific validation or settlement entry point: each such
    /// function must authenticate its exact transport caller. Otherwise a new
    /// environment added here could call ERC-4337's `validateUserOp` and collect
    /// its EntryPoint-only prefund. See
    /// docs/decisions/0020-execution-environment-boundary.md.
    function _isExecutionEnvironment(address caller) internal view returns (bool) {
        return caller == entryPoint;
    }

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
        validationData = _validateAuthority(
            userOpHash, userOp.nonce, userOp.signature, userOp.callData, _paymaster(userOp.paymasterAndData)
        );
        if (missingAccountFunds != 0) {
            // Best-effort EntryPoint prefund. The EntryPoint enforces sufficient
            // payment and reverts the operation if this account underpays, so the
            // transfer result is intentionally not asserted here.
            (bool sent,) = payable(msg.sender).call{value: missingAccountFunds}("");
            sent;
        }
    }

    /// @notice The canonical authorization boundary: decode this account's
    /// signature envelope, require the named validator to be installed, and let
    /// it decide.
    /// @dev Everything above this function is transport; everything below is
    /// authority. `validateUserOp` is ERC-4337's transport and must stay on the
    /// account because the EntryPoint calls the sender at a fixed selector. A
    /// second execution environment adds its own entry function that decodes its
    /// own calldata shape and calls this one.
    ///
    /// The envelope decode and the installed-module check live here rather than
    /// in the caller on purpose: an entry function that supplied the validator
    /// address would have to repeat the installed check, and one that forgot it
    /// would be an authorization bypass. The try/catch is here for the same
    /// reason -- failing closed on a reverting validator is one boundary, not
    /// one per environment (MEDIUM-04 in
    /// docs/reviews/preliminary-review-disposition.md).
    ///
    /// The EntryPoint prefund is deliberately not a parameter. Paying for gas is
    /// settlement, not authorization, and a second environment should not have
    /// to pass a meaningless value for it. See
    /// docs/decisions/0020-execution-environment-boundary.md.
    function _validateAuthority(
        bytes32 operationHash,
        uint256 nonce,
        bytes calldata signatureEnvelope,
        bytes calldata callData,
        address paymaster
    ) internal returns (uint256 validationData) {
        (bool resolved, address validator, bytes memory validatorSignature) =
            _resolveInstalledValidator(signatureEnvelope);
        if (!resolved) return ValidationDataLib.SIG_VALIDATION_FAILED;
        try ILoomValidator(validator)
            .validateUserOp(address(this), operationHash, nonce, validatorSignature, callData, paymaster) returns (
            uint256 result
        ) {
            return result;
        } catch {
            return ValidationDataLib.SIG_VALIDATION_FAILED;
        }
    }

    /// @dev The account names a validator the same way on every path: an
    /// `(address,bytes)` envelope, and the named validator has to be installed.
    /// Both checks live here so `_validateAuthority` and `isValidSignature`
    /// cannot drift apart -- an ERC-1271 path that accepted an uninstalled
    /// validator would be a signing oracle for a module the account rejected.
    function _resolveInstalledValidator(bytes calldata signatureEnvelope)
        internal
        view
        returns (bool resolved, address validator, bytes memory validatorSignature)
    {
        (bool decoded, address candidate, bytes memory signature) = _tryDecodeSignature(signatureEnvelope);
        if (!decoded || !_modules[ModuleType.VALIDATOR][candidate]) return (false, address(0), bytes(""));
        return (true, candidate, signature);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (bool resolved, address validator, bytes memory validatorSignature) = _resolveInstalledValidator(signature);
        if (!resolved) return ERC1271_INVALID;
        try ILoomValidator(validator).isValidSignature(address(this), hash, validatorSignature) returns (bool valid) {
            return valid ? ERC1271_MAGIC_VALUE : ERC1271_INVALID;
        } catch {
            return ERC1271_INVALID;
        }
    }

    // --- Execution ---
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable nonReentrantExecution {
        if (!_isExecutionEnvironment(msg.sender) && msg.sender != address(this)) revert OnlyEntryPoint();
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
        if (callType == ExecutionLib.CALLTYPE_BATCH) _validateBatchSize(executionCalldata);
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        bool frozen = block.timestamp < frozenUntil;
        if (frozen && !_isFrozenSafe(callType, executionCalldata)) revert AccountFrozen();

        bool bypassHooks = _isHookRecoverySchedule(callType, executionCalldata);
        address[] memory checkedHooks = new address[](0);
        bytes[] memory hookData = new bytes[](0);
        if (!bypassHooks) (checkedHooks, hookData) = _preCheck(caller, accountCall);
        if (callType == ExecutionLib.CALLTYPE_SINGLE) {
            _execute(abi.decode(executionCalldata, (ExecutionLib.Execution)));
        } else if (callType == ExecutionLib.CALLTYPE_BATCH) {
            ExecutionLib.Execution[] memory executions = abi.decode(executionCalldata, (ExecutionLib.Execution[]));
            for (uint256 i; i < executions.length; ++i) {
                _execute(executions[i]);
            }
        } else {
            revert UnsupportedExecutionMode();
        }
        if (!bypassHooks) _postCheck(checkedHooks, hookData);

        // Reaching here while frozen means `_isFrozenSafe` accepted the call, and
        // the only shape it accepts is cancelling this account's pending recovery
        // on an installed recovery module. That carve-out lets the current account
        // authority and supporting guardians stop a malicious recovery even while
        // the account is frozen. The recovery module verifies guardian support;
        // this account-level gate verifies only the exact call shape.
        //
        // Advancing the configuration makes that cancellation self-defeating. It
        // re-arms every guardian leaf, because the freeze gate compares against
        // `configVersion`, and it invalidates every pending scheduled operation,
        // migration, and vault withdrawal, because each binds the configuration
        // version it was created at. Even an authorized cancellation therefore
        // destroys the payload the freeze was buying time to stop and hands the
        // guardians another freeze.
        //
        // Only the frozen path does this. Cancelling a recovery on an unfrozen
        // account is an ordinary uncontested action and must not silently discard
        // the owner's other pending operations.
        if (frozen) _advanceConfig(FROZEN_RECOVERY_CANCELLED_HASH);
    }

    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        return mode == SINGLE_EXECUTION_MODE || mode == BATCH_EXECUTION_MODE;
    }

    function accountId() external pure returns (string memory) {
        return "loom.account";
    }

    function supportsModule(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR || moduleTypeId == ModuleType.HOOK
            || moduleTypeId == ModuleType.RECOVERY || moduleTypeId == ModuleType.MIGRATION;
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
        if (moduleTypeId == ModuleType.MIGRATION) {
            (,,,, uint48 readyAt,,,) = MigrationModule(module).pendingMigrations(address(this));
            if (readyAt != 0) revert InvalidModule();
        }
        // Removing a hook an installed validator depends on used to leave the
        // account unable to authorize anything, with no repair path: the validator
        // fails closed, `setPolicyHook` needs a scheduled self-call that only a
        // passing validator can reach, and recovery installs validators but not
        // hooks. Refuse instead. The guardian escape hatch is not blocked by this:
        // `evictHookWithGuardians` replaces the hook and rebinds dependents atomically.
        if (moduleTypeId == ModuleType.HOOK) {
            for (uint256 i; i < _validators.length; ++i) {
                if (_policyHookDependency(_validators[i]) == module) revert InvalidModule();
            }
        }
        _removeModuleState(moduleTypeId, module);
        if (deInitData.length != 0) {
            (bool ok, bytes memory result) = module.call(deInitData);
            if (!ok) revert CallFailed(result);
        }
        emit ModuleUninstalled(moduleTypeId, module);
    }

    function _removeValidatorForRecovery(address module) internal {
        if (!_modules[ModuleType.VALIDATOR][module]) revert InvalidModule();
        _removeModuleState(ModuleType.VALIDATOR, module);
        emit ModuleUninstalled(ModuleType.VALIDATOR, module);
    }

    function _removeModuleState(uint256 moduleTypeId, address module) internal {
        _modules[moduleTypeId][module] = false;
        if (moduleTypeId == ModuleType.VALIDATOR) {
            --_validatorCount;
            _removeFromArray(_validators, module);
        } else if (moduleTypeId == ModuleType.HOOK) {
            _removeFromArray(_hooks, module);
        } else if (moduleTypeId == ModuleType.RECOVERY) {
            --_recoveryModuleCount;
        } else if (moduleTypeId == ModuleType.MIGRATION) {
            migrationModule = address(0);
        }
    }

    /// @dev Removes the first occurrence of `value` from `array`, shifting the
    /// tail down so the relative order of the remaining entries is preserved.
    /// This matters for `_hooks`: they run in array order, so a swap-and-pop
    /// would silently reorder the surviving hooks whenever an unrelated one was
    /// uninstalled. Hooks are required to be order-independent, but "the order
    /// changed because you removed a different hook" is not a failure anyone
    /// would think to look for, and the account can make it impossible for the
    /// cost of a bounded shift - `MAX_HOOKS` is 8 and `MAX_VALIDATORS` is 16,
    /// and this runs only on the timelocked uninstall path.
    function _removeFromArray(address[] storage array, address value) internal {
        uint256 length = array.length;
        for (uint256 i; i < length; ++i) {
            if (array[i] == value) {
                for (uint256 j = i + 1; j < length; ++j) {
                    array[j - 1] = array[j];
                }
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

    /// @notice The hook `validator` requires, or zero if it declares no dependency.
    /// @dev Probed rather than required: a validator that needs no policy hook does
    /// not implement `ILoomPolicyBoundValidator`, and one that misbehaves must not be
    /// able to block module management. Both cases read as "depends on nothing",
    /// which is safe here because the consequence of a false negative is only that
    /// the account allows a removal the validator will then fail closed on -- the
    /// pre-existing behaviour -- while a revert would hand any module a veto over
    /// hook removal, including over the guardian escape hatch.
    function _policyHookDependency(address validator) internal view returns (address hook) {
        uint256 selector = 0x59874bd8; // policyHookFor(address)
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, selector))
            mstore(add(ptr, 4), address())
            // A malformed optional interface must not gain an unbounded-gas veto
            // over hook removal. Built-in mapping reads are far below this ceiling.
            let success := staticcall(30000, validator, ptr, 36, ptr, 32)
            if and(success, eq(returndatasize(), 32)) {
                let result := mload(ptr)
                if iszero(shr(160, result)) { hook := result }
            }
        }
    }

    // --- Timelocked call scheduling ---
    function scheduleCall(address target, uint256 value, bytes calldata data, uint48 delay)
        external
        onlySelf
        returns (bytes32 operationId)
    {
        uint48 minimum = target == address(this) || _modules[ModuleType.VALIDATOR][target]
            || _modules[ModuleType.HOOK][target] || _modules[ModuleType.RECOVERY][target]
            || _modules[ModuleType.MIGRATION][target]
            ? MIN_CONFIG_DELAY
            : MIN_EXTERNAL_DELAY;
        if (delay < minimum || delay > MAX_SCHEDULE_DELAY) revert InvalidDelay();
        operationId = keccak256(abi.encode(target, value, data, configVersion));
        ScheduledOperation memory existing = scheduledOperations[operationId];
        if (existing.readyAt != 0) revert OperationAlreadyScheduled();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 readyAt = uint48(block.timestamp) + delay;
        uint48 expiresAt = readyAt + SCHEDULE_WINDOW;
        // The slot's counter survives consumption, so this is the next instance.
        scheduledOperations[operationId] =
            ScheduledOperation({readyAt: readyAt, expiresAt: expiresAt, nonce: existing.nonce});
        emit OperationScheduled(operationId, readyAt, expiresAt, existing.nonce);
    }

    function cancelScheduled(bytes32 operationId) external onlySelf {
        ScheduledOperation memory operation = scheduledOperations[operationId];
        if (operation.readyAt == 0) revert OperationNotScheduled();
        _consumeScheduled(operationId, operation.nonce);
        emit OperationCancelled(operationId);
    }

    /// @notice Guardian-threshold cancellation of a pending scheduled call.
    /// @dev Every other delayed mechanism -- migration, vault withdrawal, recovery,
    /// keystore sync -- already has one; generic scheduled calls did not, so a
    /// guardian who spotted a dangerous pending operation could only freeze the
    /// account and wait for recovery to invalidate it. Guardians gain no execution
    /// or spending authority here: cancellation is the whole power.
    ///
    /// The digest binds the instance nonce, so an approval authorizes exactly the
    /// one occupant of this slot it was signed for. Cancelling publishes the
    /// approvals on chain, and this entry point is permissionless; without the nonce
    /// those archived approvals would cancel every future re-scheduling of the same
    /// call indefinitely.
    function cancelScheduledWithGuardians(
        bytes32 operationId,
        GuardianVerificationLib.Approval[] calldata guardianApprovals
    ) external {
        ScheduledOperation memory operation = scheduledOperations[operationId];
        if (operation.readyAt == 0) revert OperationNotScheduled();
        bytes32 digest = cancelScheduledDigest(operationId, configVersion, operation.nonce);
        _requireGuardianApproval(digest, guardianApprovals);
        _consumeScheduled(operationId, operation.nonce);
        emit OperationCancelled(operationId);
    }

    function cancelScheduledDigest(bytes32 operationId, uint64 operationConfigVersion, uint64 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(CANCEL_SCHEDULED_TYPEHASH, operationId, operationConfigVersion, nonce));
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    /// @dev Clears the pending operation and advances the slot's instance counter,
    /// so any approval signed for it -- including one a guardian cancellation just
    /// revealed on chain -- cannot authorize the next occupant.
    function _consumeScheduled(bytes32 operationId, uint64 nonce) internal {
        scheduledOperations[operationId] = ScheduledOperation({readyAt: 0, expiresAt: 0, nonce: nonce + 1});
    }

    // Hooks gate every unscheduled execute()/executeDirect() call. A hook that
    // reverts or never returns blocks all ordinary fund movement until the
    // scheduled removal path clears MIN_CONFIG_DELAY. The guardian threshold
    // can evict a hook immediately instead, since reaching threshold consensus
    // to remove (never install) a hook is itself the security bar - this
    // mirrors cancelMigrationWithGuardians, which is also immediate.
    /// @notice Guardian-threshold removal of a stuck or malicious hook, optionally
    /// swapping in a replacement in the same call.
    /// @param replacement A hook to install and rebind dependent validators onto, or
    /// the zero address to evict without one. A replacement is required when any
    /// installed validator depends on `hook`, because evicting without one would
    /// leave the account unable to authorize anything and unrecoverable.
    /// @dev The swap is atomic and ordered: install the replacement, enter the
    /// scheduled-configuration context, remove the old hook, and rebind every
    /// dependent validator. Any failed rebind rolls the entire transaction back.
    /// Reusing the scheduled-configuration flag keeps rebinding unavailable to
    /// ordinary untimelocked account execution without adding another authority bit.
    function evictHookWithGuardians(
        address hook,
        address replacement,
        GuardianVerificationLib.Approval[] calldata guardianApprovals
    ) external {
        bytes32 digest = evictHookDigest(hook, replacement, configVersion);
        _requireGuardianApproval(digest, guardianApprovals);
        if (replacement == address(0)) {
            _uninstallModule(ModuleType.HOOK, hook, "");
        } else {
            _installModule(ModuleType.HOOK, replacement, "");
            if (!_modules[ModuleType.HOOK][hook]) revert InvalidModule();
            _executingScheduled = true;
            _removeModuleState(ModuleType.HOOK, hook);
            emit ModuleUninstalled(ModuleType.HOOK, hook);
            for (uint256 i; i < _validators.length; ++i) {
                address validator = _validators[i];
                if (_policyHookDependency(validator) == hook) {
                    ILoomPolicyBoundValidator(validator).rebindPolicyHook(replacement);
                }
            }
            _executingScheduled = false;
        }
        // The approved EIP-712 digest already commits the account, chain, hook,
        // replacement, and pre-eviction configuration version.
        _advanceConfig(digest);
    }

    function _requireGuardianApproval(bytes32 digest, GuardianVerificationLib.Approval[] calldata guardianApprovals)
        internal
        view
    {
        if (!GuardianVerificationLib.approved(guardianRoot, guardianThreshold, digest, guardianApprovals)) {
            revert InvalidModule();
        }
    }

    function evictHookDigest(address hook, address replacement, uint64 version) public view returns (bytes32) {
        bytes32 typeHash = EVICT_HOOK_TYPEHASH;
        bytes32 structHash;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, typeHash)
            mstore(add(ptr, 32), hook)
            mstore(add(ptr, 64), replacement)
            mstore(add(ptr, 96), version)
            structHash := keccak256(ptr, 128)
        }
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function executeMigration(ExecutionLib.Execution[] calldata calls) external nonReentrantExecution {
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil) revert AccountFrozen();
        MigrationModule(_migrationModule()).consumeMigration(address(this), calls);
        bytes calldata executionCalldata = msg.data[4:];
        bytes memory accountCall = abi.encodeCall(this.execute, (BATCH_EXECUTION_MODE, executionCalldata));
        _executeAuthorized(BATCH_EXECUTION_MODE, executionCalldata, msg.sender, accountCall);
    }

    function _migrationModule() internal view returns (address module) {
        module = migrationModule;
        if (module == address(0) || !_modules[ModuleType.MIGRATION][module]) revert InvalidModule();
    }

    // --- Scheduled execution and allowance revocation ---
    function executeScheduled(address target, uint256 value, bytes calldata data) external nonReentrantExecution {
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < frozenUntil) revert AccountFrozen();
        bytes32 operationId = keccak256(abi.encode(target, value, data, configVersion));
        ScheduledOperation memory operation = scheduledOperations[operationId];
        if (operation.readyAt == 0) revert OperationNotScheduled();
        // Timestamp drift is negligible relative to the multi-day security delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < operation.readyAt) revert OperationNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > operation.expiresAt) revert OperationExpired();
        // Consuming here, before the call, keeps the operation single-use and
        // advances the instance counter so a cancellation approval signed for it
        // cannot authorize the slot's next occupant.
        _consumeScheduled(operationId, operation.nonce);
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
                && moduleTypeId != ModuleType.RECOVERY && moduleTypeId != ModuleType.MIGRATION
                || module.code.length == 0 || !ILoomModule(module).isModuleType(moduleTypeId)
        ) revert UnsupportedModuleType();
        if (_modules[moduleTypeId][module]) revert InvalidModule();
        if (moduleTypeId == ModuleType.VALIDATOR && _validatorCount >= MAX_VALIDATORS) revert ModuleLimitReached();
        if (moduleTypeId == ModuleType.HOOK && _hooks.length >= MAX_HOOKS) revert ModuleLimitReached();
        if (moduleTypeId == ModuleType.RECOVERY && _recoveryModuleCount >= MAX_RECOVERY_MODULES) {
            revert ModuleLimitReached();
        }
        if (moduleTypeId == ModuleType.MIGRATION && migrationModule != address(0)) revert ModuleLimitReached();
        if (moduleTypeId == ModuleType.MIGRATION && initData.length != 0) revert InvalidModule();
        _modules[moduleTypeId][module] = true;
        if (moduleTypeId == ModuleType.VALIDATOR) {
            ++_validatorCount;
            _validators.push(module);
        }
        if (moduleTypeId == ModuleType.HOOK) _hooks.push(module);
        if (moduleTypeId == ModuleType.RECOVERY) ++_recoveryModuleCount;
        if (moduleTypeId == ModuleType.MIGRATION) migrationModule = module;
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

    /// @dev Hooks are peers around one execution, not nested wrappers: every
    /// `preCheck` runs before the first target call and every `postCheck` after
    /// the last, both in installation order. The hook set is snapshotted here
    /// so a hook uninstalled mid-execution still receives its `postCheck` and
    /// the pairing stays symmetric. A reverting `preCheck` reverts everything,
    /// so earlier hooks get no `postCheck` - their state is rolled back with
    /// it. See docs/design/execution.md for the full composition contract.
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
        bool ok;
        uint256 returnDataSize;
        address target = execution.target;
        uint256 value = execution.value;
        bytes memory callData = execution.callData;
        // A smart account must be able to send authorized ETH to arbitrary targets.
        // slither-disable-next-line arbitrary-send-eth
        assembly ("memory-safe") {
            ok := call(gas(), target, value, add(callData, 32), mload(callData), 0, 0)
            returnDataSize := returndatasize()
        }
        if (!ok) {
            if (returnDataSize > MAX_REVERT_DATA_LENGTH) revert ReturnDataLimitExceeded(returnDataSize);
            assembly ("memory-safe") {
                let result := mload(0x40)
                returndatacopy(result, 0, returnDataSize)
                revert(result, returnDataSize)
            }
        }
    }

    function _validateBatchSize(bytes calldata executionCalldata) internal pure {
        if (executionCalldata.length < 64) revert InvalidBatch();
        uint256 arrayOffset;
        uint256 count;
        assembly ("memory-safe") {
            arrayOffset := calldataload(executionCalldata.offset)
            count := calldataload(add(executionCalldata.offset, 32))
        }
        if (arrayOffset != 32) revert InvalidBatch();
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH_SIZE) revert BatchLimitExceeded();
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
        if (
            selector != CANCEL_RECOVERY || callData.length < CANCEL_RECOVERY_MIN_SELECTOR_AND_STATIC_ARGS_SIZE
                || execution.value != 0
        ) return false;
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
