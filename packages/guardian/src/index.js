import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import sha3 from "js-sha3";

const { keccak256 } = sha3;

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const BACKUP_VERSION = 1;

export class InvalidGuardianCeremonyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InvalidGuardianCeremonyError";
    this.details = details;
  }
}

export function guardianLeaf(input) {
  const verifier = normalizeAddress(input?.verifier, "verifier");
  const verifierCodeHash = normalizeBytes32(input?.verifierCodeHash, "verifier code hash");
  const keyCommitment = normalizeBytes32(input?.keyCommitment, "key commitment");
  const salt = normalizeBytes32(input?.salt, "salt");
  return keccakHex(`${encodeAddress(verifier)}${strip0x(verifierCodeHash)}${strip0x(keyCommitment)}${strip0x(salt)}`);
}

export function buildGuardianTree(guardians) {
  if (!Array.isArray(guardians) || guardians.length === 0) {
    throw new InvalidGuardianCeremonyError("guardian tree requires at least one guardian");
  }
  const leaves = guardians.map((guardian, index) => Object.freeze({
    index,
    verifier: normalizeAddress(guardian.verifier, `guardian[${index}].verifier`),
    verifierCodeHash: normalizeBytes32(guardian.verifierCodeHash, `guardian[${index}].verifierCodeHash`),
    keyCommitment: normalizeBytes32(guardian.keyCommitment, `guardian[${index}].keyCommitment`),
    salt: normalizeBytes32(guardian.salt, `guardian[${index}].salt`),
    leaf: guardianLeaf(guardian)
  })).sort((a, b) => compareHex(a.leaf, b.leaf));

  for (let i = 1; i < leaves.length; i += 1) {
    if (leaves[i].leaf === leaves[i - 1].leaf) {
      throw new InvalidGuardianCeremonyError("duplicate guardian leaf", { leaf: leaves[i].leaf });
    }
  }

  const layers = [Object.freeze(leaves.map(item => item.leaf))];
  while (layers[layers.length - 1].length > 1) {
    const previous = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < previous.length; i += 2) {
      const left = previous[i];
      const right = previous[i + 1] ?? previous[i];
      next.push(hashPair(left, right));
    }
    layers.push(Object.freeze(next));
  }

  return Object.freeze({
    root: layers[layers.length - 1][0],
    leaves: Object.freeze(leaves),
    layers: Object.freeze(layers),
    proofFor(leaf) {
      return guardianProof(layers, normalizeBytes32(leaf, "leaf"));
    }
  });
}

export function guardianProof(layers, leaf) {
  let index = layers[0].indexOf(normalizeBytes32(leaf, "leaf"));
  if (index === -1) throw new InvalidGuardianCeremonyError("leaf is not in guardian tree");
  const proof = [];
  for (let level = 0; level < layers.length - 1; level += 1) {
    const layer = layers[level];
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(layer[siblingIndex] ?? layer[index]);
    index = Math.floor(index / 2);
  }
  return Object.freeze(proof);
}

export function verifyGuardianProof({ root, leaf, proof }) {
  let computed = normalizeBytes32(leaf, "leaf");
  for (const sibling of proof ?? []) {
    computed = hashPair(computed, normalizeBytes32(sibling, "proof item"));
  }
  return computed === normalizeBytes32(root, "root");
}

export function createGuardianPossessionChallenge(input) {
  const account = normalizeAddress(input?.account, "account");
  const chainId = normalizePositiveInteger(input?.chainId, "chainId");
  const ceremonyId = normalizeBytes32(input?.ceremonyId, "ceremony id");
  const expiresAt = normalizePositiveInteger(input?.expiresAt, "expiresAt");
  const leaf = guardianLeaf(input);
  const digest = keccakHex(
    [
      encodeAddress(account),
      encodeUint256(chainId),
      strip0x(ceremonyId),
      strip0x(leaf),
      encodeUint256(expiresAt)
    ].join("")
  );
  return Object.freeze({
    account,
    chainId,
    ceremonyId,
    verifier: normalizeAddress(input.verifier, "verifier"),
    keyCommitment: normalizeBytes32(input.keyCommitment, "key commitment"),
    leaf,
    expiresAt,
    digest,
    message: `Loom guardian proof-of-possession\naccount=${account}\nchainId=${chainId}\nleaf=${leaf}\nexpiresAt=${expiresAt}`
  });
}

export function buildGuardianCeremony(input) {
  const tree = buildGuardianTree(input?.guardians);
  const threshold = normalizePositiveInteger(input?.threshold, "threshold");
  if (threshold > tree.leaves.length) {
    throw new InvalidGuardianCeremonyError("guardian threshold exceeds guardian count", {
      threshold,
      guardianCount: tree.leaves.length
    });
  }
  const account = input.account === undefined ? undefined : normalizeAddress(input.account, "account");
  const chainId = input.chainId === undefined ? undefined : normalizePositiveInteger(input.chainId, "chainId");
  const ceremonyId = input.ceremonyId === undefined ? randomBytes32() : normalizeBytes32(input.ceremonyId, "ceremony id");

  return Object.freeze({
    version: 1,
    account,
    chainId,
    ceremonyId,
    guardianRoot: tree.root,
    threshold,
    guardianCount: tree.leaves.length,
    leaves: tree.leaves,
    proofs: Object.freeze(tree.leaves.map(item => Object.freeze({ leaf: item.leaf, proof: tree.proofFor(item.leaf) }))),
    evidenceHash: keccakHex(
      [
        strip0x(tree.root),
        encodeUint256(threshold),
        account === undefined ? "".padStart(64, "0") : encodeAddress(account),
        chainId === undefined ? "".padStart(64, "0") : encodeUint256(chainId),
        strip0x(ceremonyId)
      ].join("")
    )
  });
}

export function encryptGuardianBackup(input) {
  const passphrase = input?.passphrase;
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new InvalidGuardianCeremonyError("backup passphrase must be at least 12 characters");
  }
  const salt = input.salt === undefined ? randomBytes(16) : hexToBuffer(input.salt, "backup salt");
  const iv = input.iv === undefined ? randomBytes(12) : hexToBuffer(input.iv, "backup iv");
  if (salt.length !== 16) throw new InvalidGuardianCeremonyError("backup salt must be 16 bytes");
  if (iv.length !== 12) throw new InvalidGuardianCeremonyError("backup iv must be 12 bytes");
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(input.payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Object.freeze({
    version: BACKUP_VERSION,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: bufferToHex(salt),
    iv: bufferToHex(iv),
    authTag: bufferToHex(authTag),
    ciphertext: bufferToHex(ciphertext)
  });
}

export function decryptGuardianBackup(input) {
  if (input?.version !== BACKUP_VERSION || input.kdf !== "scrypt" || input.cipher !== "aes-256-gcm") {
    throw new InvalidGuardianCeremonyError("unsupported guardian backup envelope");
  }
  const passphrase = input.passphrase;
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new InvalidGuardianCeremonyError("backup passphrase must be at least 12 characters");
  }
  const key = scryptSync(passphrase, hexToBuffer(input.salt, "backup salt"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, hexToBuffer(input.iv, "backup iv"));
  decipher.setAuthTag(hexToBuffer(input.authTag, "backup auth tag"));
  const plaintext = Buffer.concat([
    decipher.update(hexToBuffer(input.ciphertext, "backup ciphertext")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function hashPair(left, right) {
  const a = normalizeBytes32(left, "left");
  const b = normalizeBytes32(right, "right");
  return compareHex(a, b) <= 0 ? keccakHex(`${strip0x(a)}${strip0x(b)}`) : keccakHex(`${strip0x(b)}${strip0x(a)}`);
}

function keccakHex(hex) {
  return `0x${keccak256(Buffer.from(hex, "hex"))}`;
}

function encodeAddress(value) {
  return strip0x(normalizeAddress(value, "address")).padStart(64, "0");
}

function encodeUint256(value) {
  return BigInt(normalizePositiveInteger(value, "uint256")).toString(16).padStart(64, "0");
}

function compareHex(a, b) {
  const left = BigInt(normalizeBytes32(a, "left"));
  const right = BigInt(normalizeBytes32(b, "right"));
  return left < right ? -1 : left > right ? 1 : 0;
}

function randomBytes32() {
  return bufferToHex(randomBytes(32));
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidGuardianCeremonyError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeAddress(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 42) throw new InvalidGuardianCeremonyError(`${label} must be a 20-byte address`);
  return hex.toLowerCase();
}

function normalizeBytes32(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 66) throw new InvalidGuardianCeremonyError(`${label} must be 32 bytes`);
  return hex.toLowerCase();
}

function normalizeHex(value, label) {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new InvalidGuardianCeremonyError(`${label} must be hex`);
  }
  return value;
}

function strip0x(value) {
  return value.slice(2);
}

function hexToBuffer(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length % 2 !== 0) throw new InvalidGuardianCeremonyError(`${label} must be byte-aligned hex`);
  return Buffer.from(strip0x(hex), "hex");
}

function bufferToHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}
