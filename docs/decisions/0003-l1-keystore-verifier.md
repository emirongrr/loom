# Ethereum L1 keystore verifier

Status: accepted
Date: 2026-06-18

## Problem

`KeystoreSyncRecoveryModule` had the right verifier boundary, but production
source code only had a test verifier. Loom needs a non-mock path for accounts
that use `LoomKeystore` directly on Ethereum L1 while keeping Base, Optimism,
and Arbitrum verification chain-specific and explicitly deferred.

## Evidence

`LoomKeystore` already stores canonical identity roots on L1, and
`KeystoreSyncRecoveryModule` already requires a verifier response before
starting delayed sync. For same-chain L1 use, an Ethereum storage proof is not
needed because the verifier can read the keystore contract directly. L2
verification still requires chain-specific accepted L1 state-root mechanisms.

## Options

- Keep only the test verifier. Rejected because it leaves the L1 keystore path
  dependent on test-only infrastructure.
- Add one generic cross-chain verifier. Rejected because Base/Optimism and
  Arbitrum have different state-root and finality assumptions.
- Add a same-chain Ethereum L1 verifier now and defer L2 adapters. Accepted
  because it is the smallest production-source step and introduces no bridge,
  oracle, or messaging authority.

## Decision

Add `EthereumL1KeystoreVerifier`, immutably bound to one `LoomKeystore`
deployment. It reads `getConfig(identityId)` directly, requires empty proof
bytes, and returns false for unknown identities, mismatched versions, or
mismatched config fields.

Acceptance condition:

- direct L1 verifier accepts exact keystore config;
- rejects wrong keystore, missing identity, non-empty proof bytes, mismatched
  fields, and mismatched version;
- `KeystoreSyncRecoveryModule` can propose sync using this verifier without
  any L1-to-L2 message.

## Residual risks

This does not support Base, Optimism, Arbitrum, or any L2. L2 support still
requires separate verifier designs, accepted L1 state-root sources, finality
rules, storage proof validation, fixtures, deployment rehearsals, and audit.
