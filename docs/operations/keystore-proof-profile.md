# Keystore Proof Profile Evidence

`tools/evidence/validate-keystore-proof-profile.mjs` validates the minimum evidence
required before any keystore proof verifier can be described as production
candidate.

This profile is intentionally stricter than a deployment manifest. A verifier
does not merely need an address and bytecode hash; it must prove that account
authority still comes from Ethereum L1 state and not from a bridge message,
oracle, sequencer promise, relayer, or Loom-operated service.

## Supported Profile Families

| Family | Verifier kind | Proof encoding | Status |
|---|---|---|---|
| Ethereum L1 | `same-chain-l1-direct-read` | `empty` | Implemented by `EthereumL1KeystoreVerifier` |
| OP Stack | `op-stack-l1-storage-proof` | `ethereum-storage-proof` | Requires chain-specific verifier, audit, and rehearsal |
| Arbitrum | `arbitrum-l1-storage-proof` | `ethereum-storage-proof` | Requires chain-specific verifier, audit, and rehearsal |

Scroll and generic bridge-message designs are deliberately out of scope.

## Required Properties

Each profile must include:

- network family, target chain ID, and Ethereum L1 chain ID;
- immutable L1 `LoomKeystore` address, runtime bytecode hash, and deployment
  block;
- immutable verifier address, runtime bytecode hash, audit evidence, and
  verifier kind matching the network family;
- proof authority set to `ethereum-l1-state`;
- explicit rejection of L1-to-L2 messaging, bridge attestation, oracle answers,
  and Loom-operated service authority;
- storage slot derivation and negative vectors for stale version, wrong
  identity, wrong slot, wrong state root, and wrong chain;
- production checks proving bytecode verification, documented storage layout,
  no messaging authority, no bridge authority, and no Loom service dependency.

L2 profiles additionally require independent audit completion and finality
parameters for the target network's accepted L1 state-root path.

## Command

```sh
npm run keystore:profile:check -- evidence/keystore/<network>.json
```

The evidence directory is intentionally not populated with fake profiles.
Production-candidate profiles should be added only after public testnet
rehearsal and review.

## Non-Goals

- This profile does not implement OP Stack or Arbitrum verifiers.
- This profile does not accept L1-to-L2 messages as authority.
- This profile does not make keystore sync production-ready by itself.
- This profile does not require a Loom-run watcher; any party may carry a
  valid proof.
