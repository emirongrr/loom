// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IGuardianVerifier} from "../interfaces/IGuardianVerifier.sol";
import {MerkleProof} from "./MerkleProof.sol";

/// @notice Single source of truth for guardian-threshold verification, shared by
/// the account (freeze/migration/hook eviction) and the recovery, keystore-sync,
/// and vault modules. Centralizing the leaf definition and the approval loop
/// keeps guardian semantics identical across every path: a guardian valid for one
/// action is valid for all of them, and there is one implementation to audit.
library GuardianVerificationLib {
    /// @param verifier Guardian verifier contract.
    /// @param keyCommitment Commitment the verifier binds (e.g. a key or address hash).
    /// @param salt Per-guardian salt included in the Merkle leaf.
    /// @param signature Verifier-specific proof of authorization over the digest.
    /// @param proof Merkle inclusion proof of the guardian leaf against the guardian root.
    struct Approval {
        address verifier;
        bytes32 keyCommitment;
        bytes32 salt;
        bytes signature;
        bytes32[] proof;
    }

    /// @notice Maximum guardian approvals accepted in one call.
    uint256 internal constant MAX_SIGNATURES = 32;

    /// @notice Maximum Merkle proof length accepted per guardian.
    uint256 internal constant MAX_PROOF_LENGTH = 32;

    /// @notice Canonical guardian Merkle leaf. Binds the verifier, its code hash,
    /// the key commitment, and the salt.
    function guardianLeaf(address verifier, bytes32 keyCommitment, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(verifier, verifier.codehash, keyCommitment, salt));
    }

    /// @notice Returns true only if `approvals` contains at least `threshold`
    /// distinct guardians (by strictly increasing leaf), each included under
    /// `root` and each producing a valid verifier signature over `digest`.
    /// Fails closed: any malformed entry, failed proof, or reverting verifier
    /// returns false rather than reverting.
    function approved(bytes32 root, uint256 threshold, bytes32 digest, Approval[] calldata approvals)
        internal
        view
        returns (bool)
    {
        if (threshold == 0 || approvals.length < threshold || approvals.length > MAX_SIGNATURES) return false;

        bytes32 previous = bytes32(0);
        for (uint256 i; i < approvals.length; ++i) {
            Approval calldata item = approvals[i];
            if (item.verifier.code.length == 0 || item.keyCommitment == bytes32(0)) return false;
            bytes32 leaf = guardianLeaf(item.verifier, item.keyCommitment, item.salt);
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
}
