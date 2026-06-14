// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomModule} from "../interfaces/ILoomModule.sol";
import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {MerkleProof} from "../libraries/MerkleProof.sol";
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

    struct GuardianApproval {
        address verifier;
        bytes32 keyCommitment;
        bytes32 salt;
        bytes signature;
        bytes32[] proof;
    }

    uint48 public constant RECOVERY_DELAY = 3 days;
    uint48 public constant RECOVERY_WINDOW = 7 days;
    uint256 public constant MAX_SIGNATURES = 32;
    uint256 public constant MAX_PROOF_LENGTH = 32;
    uint8 public constant MAX_GUARDIAN_THRESHOLD = 32;
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
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
        GuardianApproval[] calldata guardianApprovals
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
        if (!_guardianApproved(account, digest, guardianApprovals)) revert InvalidRecovery();

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

    function cancelRecoveryWithGuardians(address account, GuardianApproval[] calldata guardianApprovals) external {
        PendingRecovery memory pending = pendingRecoveries[account];
        if (pending.readyAt == 0) revert InvalidRecovery();
        bytes32 recoveryId = recoveryIdFor(account, pending);
        bytes32 digest = cancelDigest(account, recoveryId, pending.configVersion, pending.nonce);
        if (!_guardianApproved(account, digest, guardianApprovals)) revert UnauthorizedCancellation();
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
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function cancelDigest(address account, bytes32 recoveryId, uint64 configVersion, uint64 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, account, recoveryId, configVersion, nonce));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
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

    function _guardianApproved(address account, bytes32 digest, GuardianApproval[] calldata approvals)
        internal
        view
        returns (bool)
    {
        ILoomAccount loom = ILoomAccount(account);
        uint256 threshold = loom.guardianThreshold();
        if (threshold == 0 || approvals.length < threshold || approvals.length > MAX_SIGNATURES) return false;

        bytes32 root = loom.guardianRoot();
        bytes32 previous = bytes32(0);
        for (uint256 i; i < approvals.length; ++i) {
            GuardianApproval calldata item = approvals[i];
            if (item.verifier.code.length == 0 || item.keyCommitment == bytes32(0)) return false;
            bytes32 leaf = keccak256(abi.encode(item.verifier, item.verifier.codehash, item.keyCommitment, item.salt));
            if (leaf <= previous || item.proof.length > MAX_PROOF_LENGTH) return false;
            previous = leaf;
            if (!MerkleProof.verify(item.proof, root, leaf)) return false;
            try IGuardianVerifier(item.verifier).verify(item.keyCommitment, digest, item.signature) returns (
                bool valid
            ) {
                if (!valid) return false;
            } catch {
                return false;
            }
        }
        return true;
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
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
}
