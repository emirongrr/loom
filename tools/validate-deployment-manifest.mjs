import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sha3 from "js-sha3";

const { keccak_256 } = sha3;

const root = fileURLToPath(new URL("../", import.meta.url));
const file = process.argv[2];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!file) {
    throw new Error("usage: node tools/validate-deployment-manifest.mjs <manifest.json>");
  }
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await validateDeploymentManifest(manifest);
  console.log(`validated deployment manifest for chain ${manifest.network.chainId}`);
}

export async function validateDeploymentManifest(manifest, options = {}) {
  const repoRoot = options.root ?? root;
  assertTopLevel(manifest);
  assertNetwork(manifest.network);
  assertBuild(manifest.build);
  assertReproducibility(manifest.reproducibility, repoRoot);
  assertDeployments(manifest.deployments, repoRoot);
  assertAttestations(manifest.attestations);
  assertChecks(manifest.checks);
}

function assertTopLevel(manifest) {
  for (const key of ["version", "network", "build", "reproducibility", "deployments", "attestations", "checks"]) {
    if (!(key in manifest)) throw new Error(`missing top-level manifest field: ${key}`);
  }
  if (manifest.version !== 1) throw new Error("unsupported deployment manifest version");
}

function assertReproducibility(reproducibility, repoRoot) {
  if (!reproducibility || typeof reproducibility !== "object") {
    throw new Error("reproducibility must be an object");
  }
  if (!Array.isArray(reproducibility.commands) || reproducibility.commands.length === 0) {
    throw new Error("reproducibility.commands must be a non-empty array");
  }
  const commandNames = new Set();
  for (const [index, item] of reproducibility.commands.entries()) {
    const label = `reproducibility.commands[${index}]`;
    if (!item.name || typeof item.name !== "string") throw new Error(`${label}.name is required`);
    if (commandNames.has(item.name)) throw new Error(`duplicate reproducibility command: ${item.name}`);
    commandNames.add(item.name);
    if (!item.command || typeof item.command !== "string") throw new Error(`${label}.command is required`);
    if (item.exitCode !== 0) throw new Error(`${label}.exitCode must be 0`);
  }
  for (const name of ["install", "build", "verify", "manifest-check"]) {
    if (!commandNames.has(name)) throw new Error(`missing reproducibility command: ${name}`);
  }

  if (!Array.isArray(reproducibility.files) || reproducibility.files.length === 0) {
    throw new Error("reproducibility.files must be a non-empty array");
  }
  const filePaths = new Set();
  for (const [index, item] of reproducibility.files.entries()) {
    const label = `reproducibility.files[${index}]`;
    if (!item.path || typeof item.path !== "string") throw new Error(`${label}.path is required`);
    if (isAbsolute(item.path) || item.path.split(/[\\/]+/).includes("..")) {
      throw new Error(`${label}.path must stay inside repository`);
    }
    if (filePaths.has(item.path)) throw new Error(`duplicate reproducibility file: ${item.path}`);
    filePaths.add(item.path);
    assertBytes32(item.hash, `${label}.hash`);
    const path = join(repoRoot, item.path);
    if (!existsSync(path)) throw new Error(`${label}.path does not exist: ${item.path}`);
    const actual = hashBytes(readFileSync(path));
    if (item.hash !== actual) throw new Error(`${label}.hash mismatch for ${item.path}`);
  }
  for (const path of ["foundry.toml", "package-lock.json"]) {
    if (!filePaths.has(path)) throw new Error(`missing reproducibility file: ${path}`);
  }
}

function assertNetwork(network) {
  if (!network || typeof network !== "object") throw new Error("network must be an object");
  if (!network.name || typeof network.name !== "string") throw new Error("network.name is required");
  if (!["ethereum", "op-stack", "arbitrum"].includes(network.family)) {
    throw new Error("network.family must be ethereum, op-stack, or arbitrum");
  }
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) {
    throw new Error("network.chainId must be positive");
  }
  assertAddress(network.entryPoint, "network.entryPoint");
  if (network.entryPointVersion !== "0.9.0") throw new Error("network.entryPointVersion must be 0.9.0");
  assertBytes32(network.entryPointCodeHash, "network.entryPointCodeHash");
  assertAddress(network.senderCreator, "network.senderCreator");
  assertBytes32(network.senderCreatorCodeHash, "network.senderCreatorCodeHash");
  assertFinality(network.finality);

  if (!network.p256 || typeof network.p256 !== "object") throw new Error("network.p256 is required");
  if (!["precompile", "fallback-verifier"].includes(network.p256.kind)) {
    throw new Error("network.p256.kind must be precompile or fallback-verifier");
  }
  if (network.p256.kind === "precompile") {
    assertAddress(network.p256.address, "network.p256.address");
    if (network.p256.behaviorVerified !== true) throw new Error("network.p256.behaviorVerified must be true");
  } else {
    assertAddress(network.p256.address, "network.p256.address");
    assertBytes32(network.p256.codeHash, "network.p256.codeHash");
  }
}

function assertFinality(finality) {
  if (!finality || typeof finality !== "object") throw new Error("network.finality is required");
  if (!["ethereum-finalized", "op-stack-l1-finalized", "arbitrum-l1-confirmed"].includes(finality.kind)) {
    throw new Error("network.finality.kind is invalid");
  }
  if (!Number.isSafeInteger(finality.minConfirmations) || finality.minConfirmations <= 0) {
    throw new Error("network.finality.minConfirmations must be positive");
  }
  if (finality.kind !== "ethereum-finalized") {
    if (!Number.isSafeInteger(finality.l1ChainId) || finality.l1ChainId !== 1) {
      throw new Error("network.finality.l1ChainId must be Ethereum mainnet");
    }
    if (!Number.isSafeInteger(finality.challengeWindowSeconds) || finality.challengeWindowSeconds <= 0) {
      throw new Error("network.finality.challengeWindowSeconds must be positive");
    }
  }
}

function assertBuild(build) {
  if (!build || typeof build !== "object") throw new Error("build must be an object");
  if (build.solcVersion !== "0.8.35") throw new Error("build.solcVersion must be 0.8.35");
  if (build.foundryVersion !== "1.7.1") throw new Error("build.foundryVersion must be 1.7.1");
  if (build.viaIR !== true) throw new Error("build.viaIR must be true");
  if (build.optimizer?.enabled !== true || build.optimizer?.runs !== 200) {
    throw new Error("build.optimizer must be enabled with 200 runs");
  }
  if (build.evmVersion !== "osaka") throw new Error("build.evmVersion must be osaka");
  if (!build.gitCommit || typeof build.gitCommit !== "string") throw new Error("build.gitCommit is required");
  if (!build.sourceArchiveHash) throw new Error("build.sourceArchiveHash is required");
  assertBytes32(build.sourceArchiveHash, "build.sourceArchiveHash");
}

function assertDeployments(deployments, repoRoot) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("deployments must be a non-empty array");
  }

  const names = new Set();
  const salts = new Set();
  for (const [index, deployment] of deployments.entries()) {
    const label = `deployments[${index}]`;
    if (!deployment.name || typeof deployment.name !== "string") throw new Error(`${label}.name is required`);
    if (names.has(deployment.name)) throw new Error(`duplicate deployment name: ${deployment.name}`);
    names.add(deployment.name);
    assertAddress(deployment.address, `${label}.address`);
    assertBytes32(deployment.runtimeCodeHash, `${label}.runtimeCodeHash`);
    assertBytes32(deployment.initCodeHash, `${label}.initCodeHash`);
    assertBytes32(deployment.salt, `${label}.salt`);
    if (salts.has(deployment.salt)) throw new Error(`duplicate deployment salt: ${deployment.salt}`);
    salts.add(deployment.salt);
    if (!deployment.artifact || typeof deployment.artifact !== "string") {
      throw new Error(`${label}.artifact is required`);
    }
    if (isAbsolute(deployment.artifact) || deployment.artifact.split(/[\\/]+/).includes("..")) {
      throw new Error(`${label}.artifact must stay inside repository`);
    }
    assertArtifactHashes(deployment, repoRoot, label);
    if (!Array.isArray(deployment.constructorArgs)) throw new Error(`${label}.constructorArgs must be an array`);
    if (!deployment.explorer || typeof deployment.explorer !== "object") {
      throw new Error(`${label}.explorer is required`);
    }
    if (deployment.explorer.verified !== true) throw new Error(`${label}.explorer.verified must be true`);
    if (!deployment.explorer.url || typeof deployment.explorer.url !== "string") {
      throw new Error(`${label}.explorer.url is required`);
    }
    assertPublicUrl(deployment.explorer.url, `${label}.explorer.url`);
    assertDeploymentReceipt(deployment.receipt, label);
  }
}

function assertDeploymentReceipt(receipt, label) {
  if (!receipt || typeof receipt !== "object") throw new Error(`${label}.receipt is required`);
  assertTxHash(receipt.transactionHash, `${label}.receipt.transactionHash`);
  assertAddress(receipt.deployer, `${label}.receipt.deployer`);
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber <= 0) {
    throw new Error(`${label}.receipt.blockNumber must be positive`);
  }
  if (receipt.status !== "0x1") throw new Error(`${label}.receipt.status must be 0x1`);
  if (receipt.gasUsed !== undefined && (!Number.isSafeInteger(receipt.gasUsed) || receipt.gasUsed <= 0)) {
    throw new Error(`${label}.receipt.gasUsed must be positive`);
  }
}

function assertAttestations(attestations) {
  if (!Array.isArray(attestations) || attestations.length < 3) {
    throw new Error("attestations must include deployer, independent reproducer, and security reviewer");
  }
  const roles = new Set();
  const signers = new Set();
  for (const [index, attestation] of attestations.entries()) {
    const label = `attestations[${index}]`;
    if (!attestation || typeof attestation !== "object") throw new Error(`${label} must be an object`);
    if (!["deployer", "independent-reproducer", "security-reviewer"].includes(attestation.role)) {
      throw new Error(`${label}.role is invalid`);
    }
    if (roles.has(attestation.role)) throw new Error(`duplicate attestation role: ${attestation.role}`);
    roles.add(attestation.role);
    if (!attestation.signer || typeof attestation.signer !== "string") throw new Error(`${label}.signer is required`);
    if (attestation.signer.toLowerCase().includes("loom")) throw new Error(`${label}.signer must not be Loom service`);
    if (signers.has(attestation.signer.toLowerCase())) throw new Error("attestation signers must be distinct");
    signers.add(attestation.signer.toLowerCase());
    assertBytes32(attestation.manifestHash, `${label}.manifestHash`);
    if (!/^0x[0-9a-fA-F]{130}$/.test(attestation.signature ?? "")) {
      throw new Error(`${label}.signature must be a 65-byte signature`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(attestation.signedAt ?? "")) throw new Error(`${label}.signedAt is invalid`);
    if (typeof attestation.statement !== "string" || attestation.statement.length < 20) {
      throw new Error(`${label}.statement is required`);
    }
  }
  for (const role of ["deployer", "independent-reproducer", "security-reviewer"]) {
    if (!roles.has(role)) throw new Error(`missing deployment attestation role: ${role}`);
  }
}

function assertArtifactHashes(deployment, repoRoot, label) {
  const path = join(repoRoot, deployment.artifact);
  if (!existsSync(path)) throw new Error(`${label}.artifact does not exist: ${deployment.artifact}`);
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const initCode = artifact.bytecode?.object;
  const runtimeCode = artifact.deployedBytecode?.object;
  if (!isHex(initCode) || !isHex(runtimeCode)) throw new Error(`${label}.artifact missing bytecode`);
  const actualInit = hashHex(initCode);
  const actualRuntime = hashHex(runtimeCode);
  if (deployment.initCodeHash !== actualInit) {
    throw new Error(`${label}.initCodeHash mismatch for ${relative(repoRoot, path)}`);
  }
  if (deployment.runtimeCodeHash !== actualRuntime) {
    throw new Error(`${label}.runtimeCodeHash mismatch for ${relative(repoRoot, path)}`);
  }
}

function assertChecks(checks) {
  const required = [
    "cleanCheckoutBuild",
    "localBytecodeReproduction",
    "entryPointBytecodeVerified",
    "senderCreatorBytecodeVerified",
    "p256BehaviorVerified",
    "explorerSourceVerified",
    "deterministicAddressReproduction",
    "factoryRuntimeWithinEip170",
    "noAdminOrUpgradeKey",
    "noLoomServiceRequired"
  ];
  for (const key of required) {
    if (checks?.[key] !== true) throw new Error(`missing passing deployment check: ${key}`);
  }
}

function hashHex(value) {
  return `0x${keccak_256(Buffer.from(value.slice(2), "hex"))}`;
}

function hashBytes(value) {
  return `0x${keccak_256(value)}`;
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}

function assertTxHash(value, label) {
  assertBytes32(value, label);
}

function assertPublicUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error(`${label} must use http or https`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  const text = value.toLowerCase();
  for (const marker of ["apikey=", "api_key=", "access_token=", "secret=", "token="]) {
    if (text.includes(marker)) throw new Error(`${label} must not contain secret-bearing query parameters`);
  }
}

function isHex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
