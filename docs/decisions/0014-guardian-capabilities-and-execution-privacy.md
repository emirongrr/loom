# ADR 0014: Guardian capabilities and execution privacy

## Status

Accepted for the wallet/SDK boundary.

## Context

Loom commits only a guardian Merkle root and threshold. The baseline exports the full plaintext guardian set to every guardian, weakening the least-disclosure benefit off chain. Recovery approvals also expose verifier-specific evidence when submitted.

## Decision

Create one versioned capability per guardian. It contains the chain, account, untrusted owner label, guardian type and commitment, verifier address and runtime code hash, guardian-specific proof, set version/root/threshold, expiry/revocation metadata, and a random capability identifier. It never contains another guardian's descriptor. Unknown critical fields, wrong chain, stale root/config, malformed commitment, expiry, and invalid proof fail closed.

Capabilities are integrity-protected and encrypted before optional link/mailbox transport. Sensitive ciphertext references belong in URL fragments or opaque identifiers, not plaintext query parameters. The optional relay stores authenticated opaque blobs, has no signing authority, and is replaceable. File import/export remains an offline fallback. Accepted capabilities populate only a local encrypted `GuardianVault`.

On-chain storage remains root plus threshold. When a guardian acts, the verifier, commitment, salt, proof, and signature become visible. ECDSA and ERC-1271 actions may reveal a primary/linkable account. A dedicated P-256 guardian uses a recovery-specific credential, reducing identity linkage, but that public credential is revealed when used. The current protocol does not provide execution-time anonymity.

## Alternatives and future research

- A ZK proof could prove threshold-many distinct committed approvals, but requires a precise statement, nullifiers/replay rules, revocation, prover availability, circuit/setup governance, gas analysis, and independent audit.
- FROST-style threshold signatures reduce on-chain disclosure but require interactive coordination, nonce safety, DKG, membership changes, and availability planning.
- BLS aggregation simplifies one signature but adds curve/precompile, rogue-key, DKG, gas, and verifier assumptions.
- Anonymous credentials or nullifier-based approval could reduce linkage but add issuer/setup, revocation, coercion, replay, and wallet-backup complexity.

None is implemented speculatively. A future design must preserve permissionless execution, guardian revocation, config-version replay protection, and the walkaway path.

