// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ILoomAccount} from "../interfaces/ILoomAccount.sol";
import {GuardianVerificationLib} from "../libraries/GuardianVerificationLib.sol";
import {ModuleType} from "../libraries/ModuleType.sol";
import {RecoveryIdLib} from "../libraries/RecoveryIdLib.sol";

/// @notice The narrow slice of a recovery manager this board reads. Deliberately
/// not `RecoveryManager` itself: the board is a discovery channel, not a
/// component of the manager, and must not be coupled to one deployment of it.
interface IRecoveryProposalSource {
    function proposalDigest(
        address account,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 configVersion,
        uint64 nonce
    ) external view returns (bytes32);

    function recoveryNonces(address account) external view returns (uint64);
}

/// @notice The slice of a recovery manager the cancellation side reads. Kept
/// apart from `IRecoveryProposalSource` because the two describe opposite
/// requests, and a board that could confuse them would be a board that let a
/// guardian's approval count as their objection.
interface IRecoveryCancellationSource {
    function pendingRecoveries(address account)
        external
        view
        returns (
            bytes32 oldValidatorsHash,
            address newValidator,
            bytes32 initDataHash,
            bytes32 newGuardianRoot,
            uint8 newGuardianThreshold,
            uint48 readyAt,
            uint48 expiresAt,
            uint64 configVersion,
            uint64 nonce
        );

    function cancelDigest(address account, bytes32 recoveryId, uint64 configVersion, uint64 nonce)
        external
        view
        returns (bytes32);
}

/// @notice Optional publication surface that lets guardian approvals accumulate
/// across separate transactions, and lets a guardian discover that an account
/// they protect is being recovered, without anyone gaining authority.
///
/// @dev This contract has **no storage variables and no account authority**, and
/// both properties are load-bearing rather than incidental.
///
/// It is never installed as a module, so `ILoomAccount.recoverConfiguration` is
/// unreachable from it. It holds no recovery state, so it can neither withhold
/// nor corrupt one. Everything it produces is a log. Reassembling a threshold
/// bundle happens off-chain and the authoritative check remains
/// `RecoveryManager.proposeRecovery`, which re-verifies every approval from
/// scratch. Deleting this contract from a deployment removes discovery and
/// changes nothing else.
///
/// Consumers must treat a log from this contract as a *hint that is worth
/// verifying*, never as sufficient evidence. `publishApproval` cannot emit a
/// forged approval, but a consumer that skipped its own verification would still
/// be trusting this contract's correctness, which is not a trust relationship
/// this design asks for.
///
/// Recorded in `docs/decisions/0024-recovery-intent-board.md`.
contract RecoveryIntentBoard {
    error InvalidApproval();
    error SingleApprovalRequired();
    error SignatureTooLarge();
    /// @dev The account has not installed the named contract as its recovery module.
    error UnknownRecoveryManager();
    /// @dev There is no pending recovery to object to.
    error NoPendingRecovery();

    /// @notice Upper bound on a published signature, so one guardian cannot emit
    /// an unbounded log. Comfortably above a WebAuthn P-256 assertion, which is
    /// the largest approval Loom's shipped verifiers accept.
    uint256 public constant MAX_SIGNATURE_BYTES = 4096;

    /// @notice An intent to recover `account`, published by anyone.
    /// @dev Carries no authority and is **not verified**. Any address may emit
    /// this for any account, so a consumer must re-derive `recoveryId` from live
    /// account state and compare an out-of-band code before showing it as
    /// anything but unverified. Announcing is optional; the manual QR, file, and
    /// clipboard paths never require it.
    event RecoveryAnnounced(
        address indexed account,
        bytes32 indexed recoveryId,
        address recoveryManager,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 configVersion,
        uint64 nonce,
        uint48 expiresAt
    );

    /// @notice One guardian approval, verified against `account`'s live guardian
    /// root at publication time.
    /// @dev The approval tuple travels in log data so a third party can rebuild
    /// the exact `GuardianVerificationLib.Approval` the manager will accept.
    event RecoveryApprovalPublished(
        address indexed account,
        bytes32 indexed recoveryId,
        bytes32 indexed guardianLeaf,
        address recoveryManager,
        address verifier,
        bytes32 keyCommitment,
        bytes32 salt,
        bytes signature,
        bytes32[] proof
    );

    /// @notice One guardian signature against a *pending* recovery, verified at
    /// publication time exactly as an approval is.
    /// @dev Deliberately a distinct event from `RecoveryApprovalPublished`. A
    /// consumer scanning one must never pick up the other: they are signatures
    /// over different EIP-712 types answering opposite questions, and a bundle
    /// that mixed them would be refused by the manager only after the gas.
    event RecoveryCancellationPublished(
        address indexed account,
        bytes32 indexed recoveryId,
        bytes32 indexed guardianLeaf,
        address recoveryManager,
        address verifier,
        bytes32 keyCommitment,
        bytes32 salt,
        bytes signature,
        bytes32[] proof
    );

    /// @notice Publish an unverified intent to recover `account`.
    ///
    /// @dev Writes no storage and touches no authoritative state, which is why
    /// it can safely be permissionless. A flood costs the announcer full
    /// transaction gas and produces log noise that a consumer filters by the
    /// accounts it already holds a capability for. It cannot occupy a recovery
    /// slot, reset a delay, cancel, or make the account pay anything.
    ///
    /// `configVersion` and `nonce` are read from chain rather than accepted from
    /// the caller, so the emitted `recoveryId` is always well-formed for the
    /// account's current state even though the intent behind it is unverified.
    /// `expiresAt` is an unvalidated hint; consumers bound it themselves.
    function announce(
        address account,
        address recoveryManager,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint48 expiresAt
    ) external returns (bytes32 recoveryId) {
        // The caller names the manager, so the manager must be the one the
        // account itself installed. Without this the digest comes from a
        // contract of the caller's choosing, and a post could carry a genuine
        // recovery identity while its approval was verified against a digest
        // nobody with authority ever defined. An account holds at most one
        // recovery module, so this leaves no discretion.
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, recoveryManager)) {
            revert UnknownRecoveryManager();
        }
        uint64 configVersion = ILoomAccount(account).configVersion();
        uint64 nonce = IRecoveryProposalSource(recoveryManager).recoveryNonces(account);
        recoveryId = _recoveryId(
            account,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce
        );
        emit RecoveryAnnounced(
            account,
            recoveryId,
            recoveryManager,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce,
            expiresAt
        );
    }

    /// @notice Verify exactly one guardian approval against `account`'s live
    /// guardian root and publish it for later reassembly.
    ///
    /// @dev Three properties make the emitted approval trustworthy enough to be
    /// worth reassembling:
    ///
    /// 1. `configVersion` and `nonce` come from the account and the manager, not
    ///    from the caller, so an approval bound to superseded configuration or a
    ///    spent nonce cannot be published.
    /// 2. The digest is obtained from `recoveryManager.proposalDigest`, so this
    ///    contract cannot introduce a signing domain that diverges from the one
    ///    `proposeRecovery` will check. The manager's EIP-712 domain already
    ///    binds the chain and the manager's own address.
    /// 3. Verification is `GuardianVerificationLib.approved` at threshold one —
    ///    the same library, leaf definition, and fail-closed loop the account and
    ///    the manager use. There is no second verification implementation here.
    ///
    /// The array must hold exactly one approval. A batch is not accepted, because
    /// the caller wanting to submit a threshold bundle should call
    /// `proposeRecovery` directly, which anyone may do.
    ///
    /// Publishing is irreversible and reveals this guardian's verifier,
    /// commitment, salt, proof, and signature against a root that is still live.
    /// If the recovery is then abandoned or cancelled, nothing rotates and the
    /// guardian stays exposed. Clients must present this as an explicit choice
    /// and must not make it the default; see ADR-0024.
    ///
    /// @return recoveryId The identity `RecoveryManager.recoveryIdFor` will
    /// produce for the same proposal, so callers may group approvals before any
    /// proposal exists.
    function publishApproval(
        address account,
        address recoveryManager,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        GuardianVerificationLib.Approval[] calldata approvals
    ) external returns (bytes32 recoveryId) {
        if (approvals.length != 1) {
            revert SingleApprovalRequired();
        }
        if (approvals[0].signature.length > MAX_SIGNATURE_BYTES) revert SignatureTooLarge();

        // The caller names the manager, so the manager must be the one the
        // account itself installed. Without this the digest comes from a
        // contract of the caller's choosing, and a post could carry a genuine
        // recovery identity while its approval was verified against a digest
        // nobody with authority ever defined. An account holds at most one
        // recovery module, so this leaves no discretion.
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, recoveryManager)) {
            revert UnknownRecoveryManager();
        }
        uint64 configVersion = ILoomAccount(account).configVersion();
        uint64 nonce = IRecoveryProposalSource(recoveryManager).recoveryNonces(account);
        bytes32 digest = IRecoveryProposalSource(recoveryManager)
            .proposalDigest(
                account,
                oldValidatorsHash,
                newValidator,
                initDataHash,
                newGuardianRoot,
                newGuardianThreshold,
                configVersion,
                nonce
            );
        if (!GuardianVerificationLib.approved(ILoomAccount(account).guardianRoot(), 1, digest, approvals)) {
            revert InvalidApproval();
        }

        recoveryId = _recoveryId(
            account,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce
        );
        emit RecoveryApprovalPublished(
            account,
            recoveryId,
            GuardianVerificationLib.guardianLeaf(approvals[0].verifier, approvals[0].keyCommitment, approvals[0].salt),
            recoveryManager,
            approvals[0].verifier,
            approvals[0].keyCommitment,
            approvals[0].salt,
            approvals[0].signature,
            approvals[0].proof
        );
    }

    /// @notice Publish one guardian's signature to cancel the recovery currently
    /// pending against `account`.
    ///
    /// @dev The mirror of `publishApproval`, and needed for the same reason:
    /// without it, every cancellation signature has to reach one device, and a
    /// quorum that cannot assemble is a quorum that cannot act. Stopping a
    /// recovery is the more time-pressed of the two -- the delay is running --
    /// so the route that does not depend on reaching one person matters more
    /// here, not less.
    ///
    /// Nothing about the recovery is taken from the caller. The pending record
    /// is read from the manager the account installed, and `recoveryId` and the
    /// digest are derived from it, so a publication can only ever name the
    /// recovery the chain is actually holding. Proposing again advances the
    /// nonce, which moves both, so a signature cannot be carried forward to the
    /// next recovery.
    ///
    /// Still only a log, and still no authority: the manager re-verifies every
    /// approval from scratch when the cancellation is finally submitted.
    function publishCancellation(
        address account,
        address recoveryManager,
        GuardianVerificationLib.Approval[] calldata approvals
    ) external returns (bytes32 recoveryId) {
        if (approvals.length != 1) {
            revert SingleApprovalRequired();
        }
        if (approvals[0].signature.length > MAX_SIGNATURE_BYTES) revert SignatureTooLarge();
        if (!ILoomAccount(account).isModuleInstalled(ModuleType.RECOVERY, recoveryManager)) {
            revert UnknownRecoveryManager();
        }

        (
            bytes32 oldValidatorsHash,
            address newValidator,
            bytes32 initDataHash,
            bytes32 newGuardianRoot,
            uint8 newGuardianThreshold,
            uint48 readyAt,,
            uint64 configVersion,
            uint64 nonce
        ) = IRecoveryCancellationSource(recoveryManager).pendingRecoveries(account);
        // An expired recovery still occupies the slot and still needs
        // cancelling, so only the absence of one is refused.
        if (readyAt == 0) revert NoPendingRecovery();

        recoveryId = _recoveryId(
            account,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce
        );
        bytes32 digest =
            IRecoveryCancellationSource(recoveryManager).cancelDigest(account, recoveryId, configVersion, nonce);
        if (!GuardianVerificationLib.approved(ILoomAccount(account).guardianRoot(), 1, digest, approvals)) {
            revert InvalidApproval();
        }

        emit RecoveryCancellationPublished(
            account,
            recoveryId,
            GuardianVerificationLib.guardianLeaf(approvals[0].verifier, approvals[0].keyCommitment, approvals[0].salt),
            recoveryManager,
            approvals[0].verifier,
            approvals[0].keyCommitment,
            approvals[0].salt,
            approvals[0].signature,
            approvals[0].proof
        );
    }

    /// @dev Uses the same pure identity function as `RecoveryManager`, without
    /// requiring a `PendingRecovery` to exist before approvals are collected.
    function _recoveryId(
        address account,
        bytes32 oldValidatorsHash,
        address newValidator,
        bytes32 initDataHash,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold,
        uint64 configVersion,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return RecoveryIdLib.recoveryId(
            account,
            oldValidatorsHash,
            newValidator,
            initDataHash,
            newGuardianRoot,
            newGuardianThreshold,
            configVersion,
            nonce
        );
    }
}
