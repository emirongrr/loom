# Loom Guardian Package

`@loom/guardian` contains local-only ceremony helpers for wallet clients and
deployment tooling. It helps clients build the same guardian Merkle root,
guardian proofs, proof-of-possession challenges, and encrypted backup evidence
without contacting Loom infrastructure.

The package does not publish transactions, choose guardians, store secrets for
users, or verify signatures. It returns deterministic data that clients can
show, sign, back up, and compare against deployed account configuration.

## Current surface

- Guardian leaf construction compatible with Loom recovery contracts:
  `keccak256(abi.encode(verifier, verifierCodeHash, keyCommitment, salt))`.
- Sorted Merkle tree construction with sorted pair hashing.
- Per-guardian Merkle proofs matching the on-chain verifier model.
- Proof-of-possession challenge digest and human-readable message.
- Ceremony evidence hash for deployment records.
- AES-256-GCM encrypted local backup envelope using `scrypt`.

## Design rules

- Guardian salts, backup payloads, and ceremony secrets remain local.
- The public account stores only root and threshold.
- Acting guardians may reveal their verifier, commitment, salt, proof, and
  signature during recovery, so successful recovery should rotate to a fresh
  guardian root.
- No Loom service, registry, recovery provider, or frontend is required to
  construct or verify the ceremony artifacts.
- This package is client/deployment infrastructure. It does not change account
  authority.
