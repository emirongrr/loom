# optimism-trie (vendored)

Minimal vendored copy of Optimism's Merkle-Patricia-trie and RLP libraries, used
by Loom's L2 keystore proof verifiers to verify Ethereum L1 account and storage
proofs (EIP-1186) against an L1 state root read on an OP Stack L2. See
`docs/decisions/0008-op-stack-l2-keystore-verifier.md`.

## Provenance

- Upstream: [ethereum-optimism/optimism](https://github.com/ethereum-optimism/optimism)
- Path: `packages/contracts-bedrock/src/libraries/`
- Pinned commit: `b3e09977c2f1b51a7a351b8ebd4afa4122f55a46`
- Fetched: 2026-06-30
- License: MIT (see `LICENSE` in this directory)

## Files

| File | Upstream path |
|---|---|
| `Bytes.sol` | `libraries/Bytes.sol` |
| `rlp/RLPReader.sol` | `libraries/rlp/RLPReader.sol` |
| `rlp/RLPErrors.sol` | `libraries/rlp/RLPErrors.sol` |
| `trie/MerkleTrie.sol` | `libraries/trie/MerkleTrie.sol` |
| `trie/SecureMerkleTrie.sol` | `libraries/trie/SecureMerkleTrie.sol` |

## Modifications

The only change from upstream is import paths: upstream uses `src/libraries/...`
which collides with Loom's own `src/`, so imports are rewritten to the
`@optimism-trie/` remapping (`foundry.toml` and `remappings.txt`). No
Solidity logic was changed. Each file carries a provenance header recording this.

## Why vendored, not a submodule

The rest of `lib/` (account-abstraction, openzeppelin-contracts) is vendored as
plain committed files rather than git submodules; this directory follows the same
convention. Vendoring a known, pinned snapshot keeps the audited trie code under
review with the rest of the repo and avoids pulling the full Optimism monorepo.

## Updating

Do not edit these files in place. To update, re-fetch the five files from a new
pinned upstream commit, re-apply only the import-path rewrites, update the commit
hash here and in each file header, and re-run the verifier test vectors. Any
upstream change to the trie or RLP logic is in scope for re-audit before it is
relied on for production keystore sync.
