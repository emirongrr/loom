// Generates an EIP-1186 proof fixture for OPStackL2KeystoreVerifier tests.
//
// Builds an Ethereum L1 account trie containing a single `LoomKeystore` account
// whose storage trie holds one `_configs[identityId]` entry, then emits the
// account + per-slot storage proofs.
//
// It also emits an RLP-encoded L1 block header carrying that state root, and the
// header's keccak hash. The verifier does not read a state root from the
// `L1Block` predeploy -- the canonical predeploy does not publish one. It reads
// the L1 block *hash* from the predeploy, requires the caller's header to hash to
// it, and takes the state root out of the header's fourth field. The fixture
// therefore has to carry the header, not just the root.
//
// The header here is synthetic: field values other than `stateRoot` are
// placeholders, because nothing in the verifier reads them. That is enough to
// exercise the hash binding and field extraction, but it is NOT evidence that the
// contract works against a real chain. That evidence is
// test/fork/OPStackL1BlockPredeploy.fork.t.sol, which runs against the real
// predeploy, and the live rehearsal required by
// docs/operations/keystore-proof-profile.md.
//
// This script is intentionally NOT wired into package.json dependencies. To run
// it, install the generators locally without saving:
//
//   npm install --no-save @ethereumjs/mpt @ethereumjs/rlp @ethereumjs/util
//   node tools/keystore/generate-op-stack-fixture.mjs
//
// The committed artifact is test/fixtures/op-stack-keystore-proof.json. Re-run
// only when the LoomKeystore storage layout or the fixture inputs change, and
// review the regenerated proofs.

import { createMPT, createMerkleProof } from "@ethereumjs/mpt";
import { RLP } from "@ethereumjs/rlp";
import { bytesToHex, createAccount, unpadBytes, utf8ToBytes } from "@ethereumjs/util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIGS_SLOT = 1n; // LoomKeystore._configs mapping slot (controllerOf is slot 0)

const keccakStr = s => keccak_256(utf8ToBytes(s));

function u256be(value) {
  const out = new Uint8Array(32);
  let x = BigInt(value);
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

const toBig = bytes => BigInt(bytesToHex(bytes));

// Inputs (match the Solidity test constants).
const identityId = keccakStr("loom.identity.op");
const validatorRoot = keccakStr("validator root");
const guardianRoot = keccakStr("guardian root");
const appAccountRoot = keccakStr("app account root");
const guardianThreshold = 3;
const version = 1;
const keystore = keccakStr("loom.l1.keystore").slice(12); // low 20 bytes -> address

// base = keccak256(abi.encode(identityId, uint256(CONFIGS_SLOT)))
const base = toBig(keccak_256(concat(identityId, u256be(CONFIGS_SLOT))));
const slot = offset => u256be(base + BigInt(offset));

// Storage trie: value stored at each slot is RLP(unpadded slot value), which is
// what an Ethereum storage trie holds and what the verifier RLP-decodes.
const storageValue = bytes32 => RLP.encode(unpadBytes(bytes32));
const packed = u256be(BigInt(guardianThreshold) | (BigInt(version) << 8n));

const storage = await createMPT({ useKeyHashing: true });
await storage.put(slot(0), storageValue(validatorRoot));
await storage.put(slot(1), storageValue(guardianRoot));
await storage.put(slot(2), storageValue(appAccountRoot));
await storage.put(slot(3), RLP.encode(unpadBytes(packed)));
const storageRoot = storage.root();

const validatorRootProof = await createMerkleProof(storage, slot(0));
const guardianRootProof = await createMerkleProof(storage, slot(1));
const appAccountRootProof = await createMerkleProof(storage, slot(2));
const packedProof = await createMerkleProof(storage, slot(3));

// Account trie: one LoomKeystore account. codeHash is arbitrary (the verifier
// never inspects it); a non-null hash keeps the account contract-like.
const account = createAccount({
  nonce: 1n,
  balance: 0n,
  storageRoot,
  codeHash: keccakStr("loom.keystore.code")
});
const accountTrie = await createMPT({ useKeyHashing: true });
await accountTrie.put(keystore, account.serialize());
const stateRoot = accountTrie.root();
const accountProof = await createMerkleProof(accountTrie, keystore);

const hexArray = nodes => nodes.map(node => bytesToHex(node));

// Synthetic pre-London Ethereum block header: 15 fields, `stateRoot` at index 3.
// Only that field is meaningful here; the rest are placeholders the verifier never
// reads. Later forks append fields, which is why the verifier bounds the field
// count from below rather than requiring exactly 15.
const l1BlockHeader = RLP.encode([
  keccakStr("parentHash"),
  keccakStr("ommersHash"),
  keccakStr("beneficiary").slice(12),
  stateRoot,
  keccakStr("transactionsRoot"),
  keccakStr("receiptsRoot"),
  new Uint8Array(256),
  unpadBytes(u256be(1n)),
  unpadBytes(u256be(21_000_000n)),
  unpadBytes(u256be(30_000_000n)),
  unpadBytes(u256be(15_000_000n)),
  unpadBytes(u256be(1_700_000_000n)),
  utf8ToBytes("loom fixture"),
  keccakStr("mixHash"),
  new Uint8Array(8)
]);
const l1BlockHash = keccak_256(l1BlockHeader);

const fixture = {
  _comment:
    "Generated by tools/keystore/generate-op-stack-fixture.mjs. EIP-1186 proof of LoomKeystore._configs[identityId] against an L1 state root.",
  keystore: bytesToHex(keystore),
  identityId: bytesToHex(identityId),
  version,
  config: {
    validatorRoot: bytesToHex(validatorRoot),
    guardianRoot: bytesToHex(guardianRoot),
    appAccountRoot: bytesToHex(appAccountRoot),
    guardianThreshold,
    version
  },
  stateRoot: bytesToHex(stateRoot),
  l1BlockHeader: bytesToHex(l1BlockHeader),
  l1BlockHash: bytesToHex(l1BlockHash),
  accountProof: hexArray(accountProof),
  validatorRootProof: hexArray(validatorRootProof),
  guardianRootProof: hexArray(guardianRootProof),
  appAccountRootProof: hexArray(appAccountRootProof),
  packedProof: hexArray(packedProof)
};

const root = fileURLToPath(new URL("../../", import.meta.url));
const outPath = join(root, "test", "fixtures", "op-stack-keystore-proof.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${outPath}`);
console.log(`stateRoot   ${fixture.stateRoot}`);
console.log(`l1BlockHash ${fixture.l1BlockHash}`);
