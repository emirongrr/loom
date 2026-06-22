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
- Redacted onboarding evidence that proves possession, backup usability,
  threshold reachability, and privacy-preserving ceremony construction without
  publishing salts, key commitments, backup ciphertext, or guardian graphs.
- Progressive guardian setup planner for passkey-first accounts that were
  deployed without guardian recovery.

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

## Production ceremony flow

The production ceremony has two files:

- a local sensitive input file, kept by the deploying wallet/client team;
- a redacted public evidence file, committed only after review.

The local input contains guardian verifier addresses, verifier runtime code
hashes, salted key commitments, salts, proof-of-possession records, encrypted
backup hashes, usability proof, and privacy proof. It must not contain private
keys, seed phrases, passkey private material, or viewing/scanning keys.

Generate the public evidence with:

```sh
npm run guardian:evidence:build -- ceremony-input.json evidence/guardians/<network>-<account>.json
npm run guardian:test
```

Real ceremony data comes from:

- `verifier`: the deployed guardian verifier contract address for that
  guardian type;
- `verifierCodeHash`: the runtime code hash from the deployment manifest or
  `eth_getCode` + `keccak256`;
- `keyCommitment`: a verifier-specific hash of the guardian public key or
  contract identity, never the private key;
- `salt`: locally generated 32-byte randomness, stored only in encrypted
  backups and with the guardian;
- `proofsOfPossession`: signatures over
  `createGuardianPossessionChallenge(...)`, verified by the wallet/client with
  the matching ECDSA, WebAuthn P-256, ERC-1271, hardware, or institutional
  verifier logic;
- `encryptedBackups`: hashes of encrypted recovery packages after a
  decryption drill succeeds;
- `usabilityProof`: evidence that the client rebuilt the root, verified all
  proofs, can reach threshold, and decrypted backups;
- `privacyProof`: evidence that onboarding used salted commitments, produced
  redacted public output, required no central Loom service, and did not upload
  a guardian social graph.

The public evidence intentionally includes leaf hashes, proof hashes,
challenge digests, backup envelope hashes, and boolean review results. It does
not include salts, key commitments, backup ciphertext, guardian private data,
or any Loom-operated recovery dependency.

## Progressive setup planner

Passkey-first onboarding can deploy an account with no guardians. That account
must be shown as unprotected until the user schedules and executes a delayed
guardian configuration. `buildProgressiveGuardianSetupPlan(...)` converts
redacted guardian onboarding evidence into the exact account call a wallet
should ask the user to sign:

```js
import {
  buildGuardianOnboardingEvidence,
  buildProgressiveGuardianSetupPlan,
} from '@loom/guardian'

const evidence = buildGuardianOnboardingEvidence(localCeremonyInput)
const plan = buildProgressiveGuardianSetupPlan({
  account: '0x1111111111111111111111111111111111111111',
  chainId: 1,
  evidence,
})

// Submit through the account as a normal user-authorized call.
await wallet.sendCalls({
  calls: [plan.call],
})
```

The plan schedules `setGuardianConfig(guardianRoot, threshold)` through the
account's delayed self-configuration path. It is not a recovery operation, does
not grant guardians spending authority, and does not introduce a Loom-operated
coordinator. The default delay is the account config delay: 259200 seconds.

The public plan includes only the account, chain, guardian root, threshold,
ceremony id, evidence hash, delayed calldata, and user-facing review metadata.
It must not include guardian salts, key commitments, backup ciphertext, private
keys, seed phrases, viewing keys, or a guardian social graph.
