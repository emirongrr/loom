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
  assertDeployments(manifest.deployments, repoRoot);
  assertChecks(manifest.checks);
}

function assertTopLevel(manifest) {
  for (const key of ["version", "network", "build", "deployments", "checks"]) {
    if (!(key in manifest)) throw new Error(`missing top-level manifest field: ${key}`);
  }
  if (manifest.version !== 1) throw new Error("unsupported deployment manifest version");
}

function assertNetwork(network) {
  if (!network || typeof network !== "object") throw new Error("network must be an object");
  if (!network.name || typeof network.name !== "string") throw new Error("network.name is required");
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) {
    throw new Error("network.chainId must be positive");
  }
  assertAddress(network.entryPoint, "network.entryPoint");
  if (network.entryPointVersion !== "0.9.0") throw new Error("network.entryPointVersion must be 0.9.0");
  assertBytes32(network.entryPointCodeHash, "network.entryPointCodeHash");

  if (!network.p256 || typeof network.p256 !== "object") throw new Error("network.p256 is required");
  if (!["precompile", "fallback-verifier"].includes(network.p256.kind)) {
    throw new Error("network.p256.kind must be precompile or fallback-verifier");
  }
  if (network.p256.kind === "precompile") {
    assertAddress(network.p256.address, "network.p256.address");
    if (typeof network.p256.behaviorVerified !== "boolean") {
      throw new Error("network.p256.behaviorVerified must be boolean");
    }
  } else {
    assertAddress(network.p256.address, "network.p256.address");
    assertBytes32(network.p256.codeHash, "network.p256.codeHash");
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
    "p256BehaviorVerified",
    "explorerSourceVerified",
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

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}

function isHex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
