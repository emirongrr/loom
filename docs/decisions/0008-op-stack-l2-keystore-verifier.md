# OP Stack L2 keystore proof verifier

Status: draft
Date: 2026-06-30

## Problem

`EthereumL1KeystoreVerifier` is a correct same-chain L1 verifier (decision 0003)
but cannot be deployed on Base, Optimism, or any OP Stack L2 because those
chains cannot read Ethereum L1 storage directly. An L2 account that installs
`KeystoreSyncRecoveryModule` on an OP Stack chain currently has no production
verifier to supply.

Cross-chain key management is a core long-term promise. Without at least one
working L2 verifier, every L2 account is permanently locked to local-only
configuration and cannot benefit from L1-rooted keystore sync.

## Evidence

OP Stack L2s include the `L1Block` predeploy at `0x4200000000000000000000000000000000000015`.
`L1Block.stateRoot()` returns the Ethereum L1 state root of the most recently
committed L1 block as seen by the OP Stack sequencer. This is updated every L2
block. The state root is sufficient to verify any Ethereum L1 account or storage
value via a standard EIP-1186 Merkle-Patricia-trie proof without a bridge,
oracle, or Loom-operated service.

`LoomKeystore` stores `controllerOf` in slot 0 and `_configs` in slot 1.
The storage slot for `_configs[identityId]` is
`keccak256(abi.encode(identityId, uint256(1)))`. This slot commitment is
deterministic and derivable offline.

EIP-1186 storage proofs are RLP-encoded arrays of Merkle-Patricia-trie nodes
that prove a storage value at a given slot in a given account relative to a
given L1 state root. They are already produced by `eth_getProof` on any
Ethereum L1 RPC endpoint and are independently verifiable.

The OP Stack `L1Block` state root lags Ethereum L1 finality; at any given L2
block it reflects a recent L1 block but not necessarily the latest. The
sequencer can choose which L1 block to commit; this is a liveness variable
(the verifier could temporarily see a stale root) but not a safety variable
(an old root cannot make an invalidated config appear valid if the `version`
field monotonically advances).

## Options

**Option A: Use `L1Block.stateRoot()` directly with a single-level storage
proof.** The on-chain verifier reads the current `L1Block.stateRoot()` and
verifies the caller-supplied EIP-1186 account-and-storage proof against it.

- Pros: no bridge, no oracle, no Loom service; proof is self-contained in the
  transaction calldata; caller (wallet, user, watcher) can generate it from any
  Ethereum L1 RPC.
- Cons: state root reflects a recent L1 block, not latest; sequencer controls
  which L1 block is committed so root currency has a soft liveness dependency.
  `L1Block` is a sequencer-written precompile, so a sequencer that withholds
  updates delays (but does not enable) stale-config sync.

**Option B: Use `DisputeGameFactory` / `L2OutputOracle` finalized output root.**
OP Stack's dispute game protocol exposes a finalized output root after the
dispute window. Rooting the proof there would ensure higher confidence in L1
finality.

- Pros: stronger finality guarantee than `L1Block.stateRoot()`.
- Cons: output roots apply to L2 state, not L1 state directly; the mapping
  back to an L1 storage proof requires additional indirection; the dispute game
  contract address changes per deployment and per protocol upgrade; the added
  complexity is not justified for keystore config verification where `version`
  monotonicity already limits replay risk.

**Option C: Wait for a standardized cross-chain proof standard (e.g., ERC-7786,
EVM Gateway).** These would provide a unified interface.

- Rejected for now: no standard has reached the level of Ethereum L1 state
  root proofs on OP Stack chains. This does not prevent adopting a standard
  verifier adapter later.

## Decision

Implement `OPStackL2KeystoreVerifier` using **Option A**. The verifier:

1. Reads `L1Block(0x4200000000000000000000000000000000000015).stateRoot()` as
   the trusted L1 state root for this verification call.
2. Accepts a caller-supplied `proof` encoded as the RLP output of `eth_getProof`
   against the LoomKeystore address and the storage slot
   `keccak256(abi.encode(identityId, uint256(1)))` on Ethereum L1.
3. Verifies the account proof (account trie from state root to LoomKeystore
   storage root) and then the storage proof (storage trie from storage root to
   the encoded `KeystoreConfig` struct).
4. Decodes the raw storage value back to `KeystoreConfig` fields and compares
   each field to the caller-supplied `config`, and the `version` field to the
   caller-supplied `version`, before returning true.
5. Returns false for any proof failure, empty proof, wrong keystore address,
   unknown identity, mismatched field, or mismatched version — no revert-as-auth.
6. Is immutably bound to one `loomKeystore` address at construction time.
7. Is deployed independently per target OP Stack chain (Base, Optimism, etc.)
   with a chain-specific instance — no shared deployment.

Each deployment instance must pass `docs/operations/keystore-proof-profile.md`
before being described as production-candidate.

## Acceptance conditions

- `verifyKeystoreConfig` returns true for a valid proof and matching config.
- Returns false (not revert) for: empty proof, wrong keystore address, wrong
  identity, stale `version`, mismatched `validatorRoot`, mismatched
  `guardianRoot`, mismatched `appAccountRoot`, mismatched `guardianThreshold`,
  non-empty but malformed proof bytes.
- Storage slot derivation is unit-tested against known `eth_getProof` fixture
  outputs (Ethereum L1 testnet and mainnet).
- `L1Block` state root round-trip test: proof generated against an L1 block
  whose hash matches `L1Block.hash()` is accepted; proof against an older block
  root is rejected.
- Fuzzer exercises proof byte mutations to confirm no false accepts.
- `KeystoreSyncRecoveryModule` integration test: propose and execute sync on a
  testnet OP Stack chain using this verifier with two independent bundlers.
- Independent audit of the trie verification logic before production deployment.

## Storage slot derivation

```
_configs mapping is at slot 1 in LoomKeystore (after controllerOf at slot 0).
Storage slot for _configs[identityId]:
  slot = keccak256(abi.encode(identityId, uint256(1)))

KeystoreConfig is a packed struct stored across one or more consecutive slots.
struct KeystoreConfig {
  bytes32 validatorRoot;    // slot + 0
  bytes32 guardianRoot;     // slot + 1
  bytes32 appAccountRoot;   // slot + 2
  uint8   guardianThreshold;// slot + 3 (low byte)
  uint64  version;          // slot + 3 (next bytes)
}
```

The verifier must decode the final slot's packed value correctly. This must be
covered by storage-layout tests that fail if `LoomKeystore`'s storage layout
changes.

## Residual risks

- **Sequencer liveness for root currency:** The `L1Block` root can lag if the
  OP Stack sequencer delays L1 block commits. This is a liveness issue for
  keystore sync speed, not a safety issue (an attacker cannot force an old root
  to accept a newer config that has a higher version they don't control).
  `KeystoreSyncRecoveryModule`'s delay mechanism already provides a cancellation
  window even if a stale proof were somehow accepted.
- **Trie library correctness:** On-chain MPT proof verification is
  non-trivial. The implementation must be independently reviewed and fuzzer-
  tested. A bug in the trie library is in scope for the required audit.
- **Storage layout drift:** If `LoomKeystore`'s storage layout changes (a new
  state variable is added before `_configs`), the slot derivation breaks silently
  for new deployments. CI must include a storage layout pin test.
- **L2 upgrade:** If OP Stack removes or changes the `L1Block` precompile
  address or interface, the verifier breaks. This address is part of the OP
  Stack specification; breaking it would be an L2 upgrade with advance notice.
  The verifier's `L1Block` address should be a constructor argument (not
  hardcoded) to allow per-chain overrides.
- **Per-chain audit scope:** Deploying the same verifier on Base vs Optimism
  vs any other OP Stack chain still requires per-chain rehearsal and a
  chain-specific profile entry. One audit of the code does not cover all
  deployments.
