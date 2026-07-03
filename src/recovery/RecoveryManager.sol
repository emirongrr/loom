// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomModule} from "../interfaces/ILoomModule.sol";
import {EIP712Lib} from "../libraries/EIP712Lib.sol";
import {GuardianVerificationLib} from "../libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../libraries/ModuleType.sol";

contract RecoveryManager is ILoomModule {
    error InvalidRecovery();
    error RecoveryAlreadyPending();
    error RecoveryNotReady();
    error RecoveryExpired();
    error UnauthorizedCancellation();

    struct PendingRecovery {
        bytes32 oldValidatorsHash;
        address newValidator;
        bytes32 initDataHash;
        bytes32 newGuardianRoot;
        uint8 newGuardianThreshold;
        uint48 readyAt;
        uint48 expiresAt;
        uint64 configVersion;
        uint64 nonce;
    }

    uint48 public constant RECOVERY_DELAY = 3 days;
    uint48 public constant RECOVERY_WINDOW = 7 days;
    uint8 public constant MAX_GUARDIAN_THRESHOLD = 32;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = EIP712Lib.DOMAIN_TYPEHASH;
    bytes32 public constant PROPOSE_TYPEHASH = keccak256(
        "ProposeRecovery(address account,bytes32 oldValidatorsHash,address newValidator,bytes32 initDataHash,bytes32 newGuardianRoot,uint8 newGuardianThreshold,uint64 configVersion,uint64 nonce)"
    );
    bytes32 public constant CANCEL_TYPEHASH =
        keccak256("CancelRecovery(address account,bytes32 recoveryId,uint64 configVersion,uint64 nonce)");
    bytes32 private constant NAME_HASH = keccak256("LoomRecoveryManager");
    bytes32 private constant VERSION_HASH = keccak256("1");

    mapping(address account => PendingRecovery) public pendingRecoveries;
    mapping(address account => uint64 nonce) public recoveryNonces;

    event RecoveryProposed(
        address indexed account,
        bytes32 indexed recoveryId,
        address indexed newValidator,
        bytes32 oldValidatorsHash,
        uint48 readyAt,
        uint48 expiresAt
    );
    event RecoveryCancelled(address indexed account, bytes32 indexed recoveryId);
    event RecoveryExecuted(address indexed account, bytes32 indexed recoveryId, address indexed newValidator);

    function proposeRecovery(
        address account,
        address[] calldata oldValidators,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        GuardianVerificationLib.Approval[] calldata guardianApprovals
    ) external returns (bytes32 recoveryId) {
        if (pendingRecoveries[account].readyAt != 0) {
            revert RecoveryAlreadyPending();
        }
        if (
            account.code.length == 0 || newValidator.code.length == 0 || initDataHash == bytes32(0)
                || newGuardianRoot == bytes32(0) || newGuardianRoot == ILoomAccount(account).guardianRoot()
                || newGuardianThreshold == 0 || newGuardianThreshold > MAX_GUARDIAN_THRESHOLD
                || !ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, address(this))
                || ILoomAccount(account).isModuleInstalled(ModuleType.VALIDATOR, newValidator)
                || !_validCompleteValidatorSet(account, oldValidators)
        ) revert InvalidRecovery();

        uint64 nonce = recoveryNonces[account];
        uint64 configVersion = ILoomAccount(account).configVersion();
        bytes32 oldValidatorsHash = keccak256(abi.encode(oldValidators));
        bytes32 digest = proposalDigest(
            account,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce
        );
        if (!GuardianVerificationLib.approved(
                ILoomAccount(account).guardianRoot(),
                ILoomAccount(account).guardianThreshold(),
                digest,
                guardianApprovals
            )) revert InvalidRecovery();

        recoveryId = keccak256(
            abi.encode(
                account,
                oldValidatorsHash,
                newValidator,
                initDataHash,
                newGuardianRoot,
                newGuardianThreshold,
                configVersion,
                nonce
            )
        );
        // Timestamp drift is negligible relative to the multi-day recovery delay.
        // forge-lint: disable-next-line(block-timestamp)
        uint48 readyAt = uint48(block.timestamp) + RECOVERY_DELAY;
        pendingRecoveries[account] = PendingRecovery({
            oldValidatorsHash: oldValidatorsHash,
            newValidator: newValidator,
            initDataHash: initDataHash,
            newGuardianRoot: newGuardianRoot,
            newGuardianThreshold: newGuardianThreshold,
            readyAt: readyAt,
            expiresAt: readyAt + RECOVERY_WINDOW,
            configVersion: configVersion,
            nonce: nonce
        });
        emit RecoveryProposed(account, recoveryId, newValidator, oldValidatorsHash, readyAt, readyAt + RECOVERY_WINDOW);
    }

    function cancelRecovery(address account) external {
        PendingRecovery memory pending = pendingRecoveries[account];
        if (pending.readyAt == 0) revert InvalidRecovery();
        if (msg.sender != account) revert UnauthorizedCancellation();
        _cancel(account, pending);
    }

    function cancelRecoveryWithGuardians(address account, GuardianVerificationLib.Approval[] calldata guardianApprovals)
        external
    {
        PendingRecovery memory pending = pendingRecoveries[account];
        if (pending.readyAt == 0) revert InvalidRecovery();
        bytes32 recoveryId = recoveryIdFor(account, pending);
        bytes32 digest = cancelDigest(account, recoveryId, pending.configVersion, pending.nonce);
        ILoomAccount loom = ILoomAccount(account);
        if (!GuardianVerificationLib.approved(loom.guardianRoot(), loom.guardianThreshold(), digest, guardianApprovals))
        {
            revert UnauthorizedCancellation();
        }
        _cancel(account, pending);
    }

    function executeRecovery(address account, address[] calldata oldValidators, bytes calldata initData) external {
        PendingRecovery memory pending = pendingRecoveries[account];
        if (
            pending.readyAt == 0 || keccak256(abi.encode(oldValidators)) != pending.oldValidatorsHash
                || keccak256(initData) != pending.initDataHash
        ) revert InvalidRecovery();
        // Timestamp drift is negligible relative to the multi-day recovery delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.readyAt) revert RecoveryNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > pending.expiresAt) revert RecoveryExpired();
        if (ILoomAccount(account).configVersion() != pending.configVersion) revert InvalidRecovery();

        bytes32 recoveryId = recoveryIdFor(account, pending);
        delete pendingRecoveries[account];
        recoveryNonces[account] = pending.nonce + 1;
        ILoomAccount(account)
            .recoverConfiguration(
                oldValidators, pending.newValidator, initData, pending.newGuardianRoot, pending.newGuardianThreshold
            );
        emit RecoveryExecuted(account, recoveryId, pending.newValidator);
    }

    function recoveryIdFor(address account, PendingRecovery memory pending) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                account,
                pending.oldValidatorsHash,
                pending.newValidator,
                pending.initDataHash,
                pending.newGuardianRoot,
                pending.newGuardianThreshold,
                pending.configVersion,
                pending.nonce
            )
        );
    }

    function proposalDigest(
        address account,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 configVersion,
        uint64 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PROPOSE_TYPEHASH,
                account,
                oldValidatorsHash,
                newValidator,
                initDataHash,
                newGuardianRoot,
                newGuardianThreshold,
                configVersion,
                nonce
            )
        );
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function cancelDigest(address account, bytes32 recoveryId, uint64 configVersion, uint64 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, account, recoveryId, configVersion, nonce));
        return EIP712Lib.digest(_domainSeparator(), structHash);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.RECOVERY;
    }

    function _cancel(address account, PendingRecovery memory pending) internal {
        bytes32 recoveryId = recoveryIdFor(account, pending);
        delete pendingRecoveries[account];
        recoveryNonces[account] = pending.nonce + 1;
        emit RecoveryCancelled(account, recoveryId);
    }

    function _validCompleteValidatorSet(address account, address[] calldata validators) internal view returns (bool) {
        ILoomAccount loom = ILoomAccount(account);
        if (validators.length == 0 || validators.length != loom.validatorCount()) return false;
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            if (validators[i] <= previous || !loom.isModuleInstalled(ModuleType.VALIDATOR, validators[i])) {
                return false;
            }
            previous = validators[i];
        }
        return true;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return EIP712Lib.domainSeparator(NAME_HASH, VERSION_HASH);
    }
}
