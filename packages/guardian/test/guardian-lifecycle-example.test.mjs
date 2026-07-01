import assert from "node:assert/strict";
import test from "node:test";
import sha3 from "js-sha3";
import { buildGuardianTree, guardianLeaf, verifyGuardianProof } from "../src/index.js";

const { keccak256 } = sha3;

// End-to-end example plus a cross-layer consistency guard for the guardian
// Merkle tooling. The guardian set is committed on-chain only as a Merkle root
// (privacy-until-participation): the account never stores guardian addresses,
// and a guardian reveals its leaf only when it freezes or joins recovery.
//
// The second test pins the SDK's leaf and proof construction to the exact
// on-chain byte layout, using independent reimplementations of the contract
// spec. If either side drifts (a dropped field, a different encoding, an
// unsorted pair), SDK-built roots would silently fail on-chain; this fails CI
// instead.

const guardians = [
  {
    verifier: "0x2222222222222222222222222222222222222222",
    verifierCodeHash: `0x${"a1".repeat(32)}`,
    keyCommitment: `0x${"b1".repeat(32)}`,
    salt: `0x${"c1".repeat(32)}`
  },
  {
    verifier: "0x3333333333333333333333333333333333333333",
    verifierCodeHash: `0x${"a2".repeat(32)}`,
    keyCommitment: `0x${"b2".repeat(32)}`,
    salt: `0x${"c2".repeat(32)}`
  },
  {
    verifier: "0x4444444444444444444444444444444444444444",
    verifierCodeHash: `0x${"a3".repeat(32)}`,
    keyCommitment: `0x${"b3".repeat(32)}`,
    salt: `0x${"c3".repeat(32)}`
  }
];

const strip = hex => hex.slice(2).toLowerCase();
const keccakHex = hex => `0x${keccak256(Buffer.from(hex, "hex"))}`;

// Independent reimplementation of LoomAccount.guardianLeaf
// (src/account/LoomAccount.sol:559-561):
//   keccak256(abi.encode(verifier, verifier.codehash, keyCommitment, salt))
// abi.encode left-pads the address to a full word; the three bytes32 follow.
function onchainLeaf({ verifier, verifierCodeHash, keyCommitment, salt }) {
  const paddedVerifier = strip(verifier).padStart(64, "0");
  return keccakHex(paddedVerifier + strip(verifierCodeHash) + strip(keyCommitment) + strip(salt));
}

// Independent reimplementation of MerkleProof.verify
// (src/libraries/MerkleProof.sol): sorted-pair keccak256(abi.encodePacked(a, b))
// walked from the leaf to the root.
function onchainVerify(leaf, proof, root) {
  let computed = leaf.toLowerCase();
  for (const sibling of proof) {
    const s = sibling.toLowerCase();
    computed = BigInt(computed) <= BigInt(s)
      ? keccakHex(strip(computed) + strip(s))
      : keccakHex(strip(s) + strip(computed));
  }
  return computed === root.toLowerCase();
}

test("guardian lifecycle: build the tree, derive the on-chain root, prove one guardian", () => {
  // 1. The user assembles the guardian set off-chain and builds the Merkle tree.
  const tree = buildGuardianTree(guardians);

  // 2. tree.root is the only guardian data committed on-chain. It is supplied as
  //    the new guardian root when configuring or recovering the account,
  //    alongside the guardian threshold.
  assert.match(tree.root, /^0x[0-9a-f]{64}$/);

  // 3. To freeze the account or take part in recovery, a single guardian needs
  //    an inclusion proof for its own leaf.
  const target = guardians[0];
  const leaf = guardianLeaf(target);
  const proof = tree.proofFor(leaf);

  // 4. That leaf input and proof are exactly what the guardian submits on-chain,
  //    e.g. freeze(verifier, keyCommitment, salt, proof, signature). The account
  //    recomputes the leaf from (verifier, verifier.codehash, keyCommitment,
  //    salt) and checks the proof against the stored root.
  assert.equal(verifyGuardianProof({ root: tree.root, leaf, proof }), true);
});

test("guardian tooling matches the on-chain leaf and Merkle verification byte-for-byte", () => {
  const tree = buildGuardianTree(guardians);

  // Leaf construction must match LoomAccount.guardianLeaf exactly, including the
  // verifier code hash.
  for (const guardian of guardians) {
    assert.equal(
      guardianLeaf(guardian),
      onchainLeaf(guardian),
      "SDK guardian leaf diverged from LoomAccount.guardianLeaf"
    );
  }

  // The SDK-built root and proof must satisfy the contract's own MerkleProof
  // verification, not only the SDK's verifier.
  for (const guardian of guardians) {
    const leaf = guardianLeaf(guardian);
    const proof = tree.proofFor(leaf);
    assert.equal(
      onchainVerify(leaf, proof, tree.root),
      true,
      "SDK guardian proof rejected by the on-chain MerkleProof algorithm"
    );
  }

  // A tampered proof is rejected by the on-chain algorithm too.
  const leaf = guardianLeaf(guardians[0]);
  const tampered = [...tree.proofFor(leaf)];
  tampered[0] = `0x${"de".repeat(32)}`;
  assert.equal(onchainVerify(leaf, tampered, tree.root), false);
});
