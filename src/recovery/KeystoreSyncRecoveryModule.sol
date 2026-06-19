// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IKeystoreProofVerifier} from "../interfaces/IKeystoreProofVerifier.sol";
import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {ILoomKeystore} from "../interfaces/ILoomKeystore.sol";
import {ILoomModule} from "../interfaces/ILoomModule.sol";
import {MerkleProof} from "../libraries/MerkleProof.sol";
import {ModuleType} from "../libraries/ModuleType.sol";

contract KeystoreSyncRecoveryModule is ILoomModule {
    error InvalidSync();
    error SyncAlreadyPending();
    error SyncNotPending();
    error SyncNotReady();
    error SyncExpired();
    error UnauthorizedCancellation();

    struct PendingSync {
        bytes32 identityId;
        bytes32 oldValidatorsHash;
        bytes32 newValidatorRoot;
        bytes32 newValidatorsHash;
        bytes32 newGuardianRoot;
        uint8 newGuardianThreshold;
        uint64 l1Version;
        uint48 readyAt;
        uint48 expiresAt;
        uint64 accountConfigVersion;
        uint64 nonce;
    }

    struct GuardianApproval {
        address verifier;
        bytes32 keyCommitment;
        bytes32 salt;
        bytes signature;
        bytes32[] proof;
    }

    uint48 public constant SYNC_DELAY = 3 days;
    uint48 public constant SYNC_WINDOW = 7 days;
    uint256 public constant MAX_SIGNATURES = 32;
    uint256 public constant MAX_PROOF_LENGTH = 32;
    uint256 public constant MAX_VALIDATORS = 16;
    uint8 public constant MAX_GUARDIAN_THRESHOLD = 32;
    bytes32 public constant SINGLE_VALIDATOR_ROOT_TYPEHASH =
        keccak256("LoomSingleValidatorRoot(address validator,bytes32 initDataHash)");
    bytes32 public constant VALIDATOR_SET_ROOT_TYPEHASH = keccak256("LoomValidatorSetRoot(bytes32 validatorsHash)");
    bytes32 public constant APP_ACCOUNT_LEAF_TYPEHASH =
        keccak256("LoomAppAccount(uint256 chainId,address account,address syncModule)");
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CANCEL_TYPEHASH =
        keccak256("CancelKeystoreSync(address account,bytes32 syncId,uint64 accountConfigVersion,uint64 nonce)");

    bytes32 private constant NAME_HASH = keccak256("LoomKeystoreSyncRecoveryModule");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public immutable l1Keystore;
    IKeystoreProofVerifier public immutable proofVerifier;

    mapping(address account => PendingSync) public pendingSyncs;
    mapping(address account => uint64 nonce) public syncNonces;
    mapping(address account => uint64 version) public lastAppliedL1Version;

    event KeystoreSyncProposed(
        address indexed account,
        bytes32 indexed identityId,
        bytes32 indexed syncId,
        uint64 l1Version,
        bytes32 newValidatorRoot,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint48 readyAt,
        uint48 expiresAt
    );
    event KeystoreSyncCancelled(address indexed account, bytes32 indexed syncId);
    event KeystoreSyncExecuted(address indexed account, bytes32 indexed identityId, bytes32 indexed syncId);

    constructor(address l1Keystore_, IKeystoreProofVerifier proofVerifier_) {
        if (l1Keystore_ == address(0) || address(proofVerifier_).code.length == 0) revert InvalidSync();
        l1Keystore = l1Keystore_;
        proofVerifier = proofVerifier_;
    }

    function proposeSync(
        address account,
        bytes32 identityId,
        ILoomKeystore.KeystoreConfig calldata config,
        bytes calldata l1Proof,
        bytes32[] calldata appAccountProof,
        address[] calldata oldValidators,
        ILoomAccount.RecoveryModuleInit[] calldata newValidators
    ) external returns (bytes32 syncId) {
        if (pendingSyncs[account].readyAt != 0) {
            revert SyncAlreadyPending();
        }
        bytes32 newValidatorsHash = keccak256(abi.encode(newValidators));
        bytes32 newValidatorRoot = validatorSetRoot(newValidators);
        if (
            account.code.length == 0 || identityId == bytes32(0) || config.version <= lastAppliedL1Version[account]
                || config.guardianRoot == bytes32(0) || config.guardianThreshold == 0
                || config.guardianThreshold > MAX_GUARDIAN_THRESHOLD || config.validatorRoot != newValidatorRoot
                || !MerkleProof.verify(appAccountProof, config.appAccountRoot, appAccountLeaf(account))
                || !ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, address(this))
                || !_validCompleteValidatorSet(account, oldValidators) || !_validNewValidatorSet(account, newValidators)
                || !proofVerifier.verifyKeystoreConfig(l1Keystore, identityId, config.version, config, l1Proof)
        ) revert InvalidSync();

        uint64 nonce = syncNonces[account];
        uint64 accountConfigVersion = ILoomAccount(account).configVersion();
        bytes32 oldValidatorsHash = keccak256(abi.encode(oldValidators));
        // Timestamp drift is negligible relative to the multi-day sync delay.
        // forge-lint: disable-next-line(block-timestamp)
        uint48 readyAt = uint48(block.timestamp) + SYNC_DELAY;
        uint48 expiresAt = readyAt + SYNC_WINDOW;
        pendingSyncs[account] = PendingSync({
            identityId: identityId,
            oldValidatorsHash: oldValidatorsHash,
            newValidatorRoot: newValidatorRoot,
            newValidatorsHash: newValidatorsHash,
            newGuardianRoot: config.guardianRoot,
            newGuardianThreshold: config.guardianThreshold,
            l1Version: config.version,
            readyAt: readyAt,
            expiresAt: expiresAt,
            accountConfigVersion: accountConfigVersion,
            nonce: nonce
        });
        syncId = syncIdFor(account, pendingSyncs[account]);
        emit KeystoreSyncProposed(
            account,
            identityId,
            syncId,
            config.version,
            newValidatorRoot,
            config.guardianRoot,
            config.guardianThreshold,
            readyAt,
            expiresAt
        );
    }

    function cancelRecovery(address account) external {
        PendingSync memory pending = pendingSyncs[account];
        if (pending.readyAt == 0) revert SyncNotPending();
        if (msg.sender != account) revert UnauthorizedCancellation();
        _cancel(account, pending);
    }

    function cancelSyncWithGuardians(address account, GuardianApproval[] calldata guardianApprovals) external {
        PendingSync memory pending = pendingSyncs[account];
        if (pending.readyAt == 0) revert SyncNotPending();
        bytes32 syncId = syncIdFor(account, pending);
        bytes32 digest = cancelDigest(account, syncId, pending.accountConfigVersion, pending.nonce);
        if (!_guardianApproved(account, digest, guardianApprovals)) revert UnauthorizedCancellation();
        _cancel(account, pending);
    }

    function executeSync(
        address account,
        address[] calldata oldValidators,
        ILoomAccount.RecoveryModuleInit[] calldata newValidators
    ) external {
        PendingSync memory pending = pendingSyncs[account];
        if (
            pending.readyAt == 0 || keccak256(abi.encode(oldValidators)) != pending.oldValidatorsHash
                || keccak256(abi.encode(newValidators)) != pending.newValidatorsHash
        ) revert InvalidSync();
        // Timestamp drift is negligible relative to the multi-day sync delay.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.readyAt) revert SyncNotReady();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > pending.expiresAt) revert SyncExpired();
        if (ILoomAccount(account).configVersion() != pending.accountConfigVersion) revert InvalidSync();

        bytes32 syncId = syncIdFor(account, pending);
        delete pendingSyncs[account];
        syncNonces[account] = pending.nonce + 1;
        lastAppliedL1Version[account] = pending.l1Version;
        ILoomAccount(account)
            .recoverConfigurationSet(
                oldValidators, newValidators, pending.newGuardianRoot, pending.newGuardianThreshold
            );
        emit KeystoreSyncExecuted(account, pending.identityId, syncId);
    }

    function syncIdFor(address account, PendingSync memory pending) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                account,
                pending.identityId,
                pending.oldValidatorsHash,
                pending.newValidatorRoot,
                pending.newValidatorsHash,
                pending.newGuardianRoot,
                pending.newGuardianThreshold,
                pending.l1Version,
                pending.readyAt,
                pending.expiresAt,
                pending.accountConfigVersion,
                pending.nonce,
                block.chainid
            )
        );
    }

    function cancelDigest(address account, bytes32 syncId, uint64 accountConfigVersion, uint64 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, account, syncId, accountConfigVersion, nonce));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function singleValidatorRoot(address validator, bytes32 initDataHash) public pure returns (bytes32) {
        return keccak256(abi.encode(SINGLE_VALIDATOR_ROOT_TYPEHASH, validator, initDataHash));
    }

    function validatorSetRoot(ILoomAccount.RecoveryModuleInit[] calldata validators) public pure returns (bytes32) {
        return keccak256(abi.encode(VALIDATOR_SET_ROOT_TYPEHASH, keccak256(abi.encode(validators))));
    }

    function appAccountLeaf(address account) public view returns (bytes32) {
        return keccak256(abi.encode(APP_ACCOUNT_LEAF_TYPEHASH, block.chainid, account, address(this)));
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.RECOVERY;
    }

    function _cancel(address account, PendingSync memory pending) internal {
        bytes32 syncId = syncIdFor(account, pending);
        delete pendingSyncs[account];
        syncNonces[account] = pending.nonce + 1;
        emit KeystoreSyncCancelled(account, syncId);
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

    function _validNewValidatorSet(address account, ILoomAccount.RecoveryModuleInit[] calldata validators)
        internal
        view
        returns (bool)
    {
        ILoomAccount loom = ILoomAccount(account);
        if (validators.length == 0 || validators.length > MAX_VALIDATORS) return false;
        address previous = address(0);
        for (uint256 i; i < validators.length; ++i) {
            ILoomAccount.RecoveryModuleInit calldata validator = validators[i];
            if (
                validator.moduleTypeId != ModuleType.VALIDATOR || validator.module <= previous
                    || validator.module.code.length == 0
                    || loom.isModuleInstalled(ModuleType.VALIDATOR, validator.module)
                    || !ILoomModule(validator.module).isModuleType(ModuleType.VALIDATOR)
            ) {
                return false;
            }
            previous = validator.module;
        }
        return true;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
}
