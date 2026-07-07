import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const file = process.argv[2];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!file) {
    throw new Error("usage: node tools/evidence/validate-keystore-proof-profile.mjs <profile.json>");
  }
  const profile = JSON.parse(await readFile(file, "utf8"));
  validateKeystoreProofProfile(profile);
  console.log(`validated keystore proof profile for chain ${profile.network.chainId}`);
}

export function validateKeystoreProofProfile(profile) {
  assertTopLevel(profile);
  assertNetwork(profile.network);
  assertL1Keystore(profile.l1Keystore);
  assertVerifier(profile.verifier, profile.network);
  assertProof(profile.proof, profile.network, profile.verifier);
  assertChecks(profile.checks, profile.network);
}

function assertTopLevel(profile) {
  for (const key of ["version", "network", "l1Keystore", "verifier", "proof", "checks"]) {
    if (!(key in profile)) throw new Error(`missing top-level keystore proof profile field: ${key}`);
  }
  if (profile.version !== 1) throw new Error("unsupported keystore proof profile version");
}

function assertNetwork(network) {
  if (!network || typeof network !== "object") throw new Error("network must be an object");
  if (!["ethereum", "op-stack", "arbitrum"].includes(network.family)) {
    throw new Error("network.family must be ethereum, op-stack, or arbitrum");
  }
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) {
    throw new Error("network.chainId must be positive");
  }
  if (!Number.isSafeInteger(network.l1ChainId) || network.l1ChainId !== 1) {
    throw new Error("network.l1ChainId must be Ethereum mainnet");
  }
  if (network.family === "ethereum" && network.chainId !== 1) {
    throw new Error("ethereum keystore profile must target chainId 1");
  }
  if (typeof network.name !== "string" || network.name.length === 0) {
    throw new Error("network.name is required");
  }
}

function assertL1Keystore(l1Keystore) {
  if (!l1Keystore || typeof l1Keystore !== "object") throw new Error("l1Keystore must be an object");
  assertAddress(l1Keystore.address, "l1Keystore.address");
  assertBytes32(l1Keystore.runtimeCodeHash, "l1Keystore.runtimeCodeHash");
  if (!Number.isSafeInteger(l1Keystore.deploymentBlock) || l1Keystore.deploymentBlock <= 0) {
    throw new Error("l1Keystore.deploymentBlock must be positive");
  }
  if (l1Keystore.upgradeable !== false) throw new Error("l1Keystore.upgradeable must be false");
}

function assertVerifier(verifier, network) {
  if (!verifier || typeof verifier !== "object") throw new Error("verifier must be an object");
  assertAddress(verifier.address, "verifier.address");
  assertBytes32(verifier.runtimeCodeHash, "verifier.runtimeCodeHash");
  if (verifier.upgradeable !== false) throw new Error("verifier.upgradeable must be false");
  if (verifier.audited !== true) throw new Error("verifier.audited must be true");
  if (!verifier.auditReport || typeof verifier.auditReport !== "string") {
    throw new Error("verifier.auditReport is required");
  }

  const allowed = {
    ethereum: "same-chain-l1-direct-read",
    "op-stack": "op-stack-l1-storage-proof",
    arbitrum: "arbitrum-l1-storage-proof"
  };
  if (verifier.kind !== allowed[network.family]) {
    throw new Error(`verifier.kind must be ${allowed[network.family]}`);
  }
}

function assertProof(proof, network, verifier) {
  if (!proof || typeof proof !== "object") throw new Error("proof must be an object");
  if (proof.authority !== "ethereum-l1-state") {
    throw new Error("proof.authority must be ethereum-l1-state");
  }
  if (proof.usesL1ToL2Messaging !== false) throw new Error("proof.usesL1ToL2Messaging must be false");
  if (proof.usesBridgeAttestation !== false) throw new Error("proof.usesBridgeAttestation must be false");
  if (proof.usesOracle !== false) throw new Error("proof.usesOracle must be false");
  if (proof.usesLoomService !== false) throw new Error("proof.usesLoomService must be false");
  if (!Array.isArray(proof.negativeTestVectors) || proof.negativeTestVectors.length < 5) {
    throw new Error("proof.negativeTestVectors must include at least five failure cases");
  }
  for (const item of proof.negativeTestVectors) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("proof.negativeTestVectors entries must be non-empty strings");
    }
  }

  if (network.family === "ethereum") {
    if (proof.encoding !== "empty") throw new Error("ethereum proof.encoding must be empty");
    if (proof.finality.kind !== "same-transaction-state") {
      throw new Error("ethereum proof.finality.kind must be same-transaction-state");
    }
    if (verifier.kind !== "same-chain-l1-direct-read") {
      throw new Error("ethereum verifier must use direct read");
    }
    return;
  }

  if (proof.encoding !== "ethereum-storage-proof") {
    throw new Error("l2 proof.encoding must be ethereum-storage-proof");
  }
  if (!proof.stateRootSource || typeof proof.stateRootSource !== "object") {
    throw new Error("l2 proof.stateRootSource is required");
  }
  if (proof.stateRootSource.family !== network.family) {
    throw new Error("proof.stateRootSource.family must match network.family");
  }
  assertAddress(proof.stateRootSource.contract, "proof.stateRootSource.contract");
  if (!Number.isSafeInteger(proof.finality.minDelaySeconds) || proof.finality.minDelaySeconds <= 0) {
    throw new Error("l2 proof.finality.minDelaySeconds must be positive");
  }
  if (!Number.isSafeInteger(proof.finality.minL1Confirmations) || proof.finality.minL1Confirmations <= 0) {
    throw new Error("l2 proof.finality.minL1Confirmations must be positive");
  }
}

function assertChecks(checks, network) {
  const required = [
    "l1KeystoreBytecodeVerified",
    "verifierBytecodeVerified",
    "storageSlotDerivationDocumented",
    "staleVersionRejected",
    "wrongIdentityRejected",
    "wrongStorageSlotRejected",
    "wrongStateRootRejected",
    "wrongChainRejected",
    "noMessagingAuthority",
    "noBridgeAuthority",
    "noLoomServiceRequired"
  ];
  for (const key of required) {
    if (checks?.[key] !== true) throw new Error(`missing passing keystore proof check: ${key}`);
  }
  if (network.family !== "ethereum" && checks.independentAuditCompleted !== true) {
    throw new Error("l2 keystore verifier requires independentAuditCompleted");
  }
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}
