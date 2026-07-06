# Global Cross-L2 Keystore

Loom follows an L1-rooted keystore direction: validation configuration should
live in one canonical place and L2 accounts should apply it only after verifying
that canonical state. The root chain for Loom is Ethereum L1.

## Components

### `LoomKeystore`

`LoomKeystore` is an L1 root registry. Each identity stores:

- `validatorRoot`
- `guardianRoot`
- `appAccountRoot`
- `guardianThreshold`
- `version`

The keystore does not contain a Loom administrator, bridge operator, relayer
role, or upgrade authority. Each identity has a `controller`; the recommended
controller is the user's L1 Loom account or another user-controlled account
with its own recovery and delay model. Updating the keystore is therefore a
user-controlled L1 action.

### `KeystoreSyncRecoveryModule`

The L2 sync module is an optional recovery module. It can replace the local
validator set and guardian configuration only when all of the following hold:

- the account installed the module as a recovery module;
- an audited proof verifier accepts the L1 keystore state;
- the L1 version is newer than the last applied version;
- the local account is included in the L1 `appAccountRoot`;
- the `validatorRoot` commits to the complete new validator set and each
  validator's initialization data;
- the complete old validator set is supplied;
- the sync delay has elapsed and the execution window has not expired;
- the local `configVersion` has not changed since proposal.

This keeps L1 as the source of truth without adding bridge trust. The module
does not accept cross-chain messages, multisig attestations, oracle answers, or
relayer claims as authority.

### `EthereumL1KeystoreVerifier`

`EthereumL1KeystoreVerifier` is the same-chain verifier for Ethereum L1. It is
used when the account and `LoomKeystore` are both on Ethereum L1, so no
cross-chain state-root proof is needed. The verifier:

- is immutably bound to one `LoomKeystore` deployment;
- rejects non-empty proof bytes;
- rejects unknown identities, mismatched versions, and mismatched config
  fields;
- reads `LoomKeystore.getConfig(identityId)` directly.

This verifier is not an L2 verifier and must not be deployed as a Base,
Optimism, or Arbitrum proof adapter. It exists to remove mock-verifier
dependency from the L1 keystore path while keeping L2 support explicitly
chain-specific.

## Proof Verifier Boundary

`IKeystoreProofVerifier` is an interface, not a placeholder verifier. A
production L2 verifier must prove Ethereum L1 keystore state against the
target chain's accepted L1 state root mechanism. Until that verifier is
independently designed, implemented, audited, and deployed for a target L2, a
production L2 account should not install keystore sync as an active recovery
path.

The same-chain Ethereum L1 verifier is intentionally simpler: it performs a
direct keystore read and accepts no proof bytes.

Test-only verifier contracts may exist under `test/`; no mock verifier belongs
under `src/`.

## Network Model

The intended network set is:

- Ethereum L1
- Base
- Arbitrum
- Optimism
- future rollups with a verifiable L1 state-root path

Support for a network is not a branding list. A network is supported only when
the verifier can validate the relevant L1 state root and storage proof under
that network's security model.

L1-to-L2 messaging is not a keystore authority path. Wallets, scripts, or
watchers may carry proofs, but a message bridge, relayer, or Loom-operated
service must never be treated as proof that an L1 config is valid.

Production-candidate verifier evidence must pass the keystore proof profile
validator described in `docs/operations/keystore-proof-profile.md`. The profile
requires immutable verifier bytecode, audit evidence, explicit finality
assumptions, storage-slot derivation, negative vectors, and proof authority
rooted in Ethereum L1 state. OP Stack and Arbitrum support remain unsupported
until their chain-specific verifier profiles and contracts pass that gate.

## Privacy Notes

The L1 keystore improves cross-chain key management but creates public
correlation risk if one identity root links every app account. `appAccountRoot`
therefore commits to authorized app accounts without requiring the L1 registry
to list them in plaintext. Users can choose separate identities for unrelated
contexts, and future privacy-preserving account membership proofs should be
added only as separately audited adapters.

## Deliberate Limits

- The current account still has local `configHash` and `configVersion`.
- Sync is delayed and cancelable; L1 updates do not instantly mutate L2 state.
- The sync module applies a complete validator-set replacement. The old set
  must be supplied in full, the new set must be sorted and duplicate-free, and
  the account applies the replacement atomically under the recovery module.
- This is not an asset bridge, force-withdrawal system, privacy pool, or light
  client wallet implementation.
