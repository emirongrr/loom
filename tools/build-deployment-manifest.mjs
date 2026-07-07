import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sha3 from "js-sha3";
import { validateDeploymentManifest } from "./validate-deployment-manifest.mjs";

const { keccak_256 } = sha3;
const root = fileURLToPath(new URL("../", import.meta.url));

const DEFAULT_BUILD = Object.freeze({
  solcVersion: "0.8.35",
  foundryVersion: "1.7.1",
  viaIR: true,
  optimizer: Object.freeze({ enabled: true, runs: 200 }),
  evmVersion: "osaka"
});

const DEFAULT_COMMANDS = Object.freeze([
  Object.freeze({ name: "install", command: "npm ci", exitCode: 0 }),
  Object.freeze({ name: "build", command: "forge build --sizes --skip \"test/**\" \"script/**\"", exitCode: 0 }),
  Object.freeze({ name: "verify", command: "npm run verify:quick", exitCode: 0 }),
  Object.freeze({
    name: "manifest-check",
    command: "npm run deployment:manifest:check -- evidence/deployments/<network>.json",
    exitCode: 0
  })
]);

const DEFAULT_REPRODUCIBILITY_FILES = Object.freeze(["foundry.toml", "package-lock.json"]);

export async function buildDeploymentManifest(config, options = {}) {
  const repoRoot = options.root ?? root;
  assertObject(config, "config");
  for (const key of ["network", "build", "deployments", "attestations", "checks"]) {
    if (!(key in config)) throw new Error(`missing deployment manifest config field: ${key}`);
  }

  const manifest = {
    version: 1,
    network: cloneJson(config.network),
    build: {
      ...DEFAULT_BUILD,
      ...cloneJson(config.build),
      optimizer: {
        ...DEFAULT_BUILD.optimizer,
        ...(config.build.optimizer ?? {})
      },
      gitCommit: config.build.gitCommit ?? currentGitCommit(repoRoot)
    },
    reproducibility: {
      commands: cloneJson(config.reproducibility?.commands ?? DEFAULT_COMMANDS),
      files: reproducibilityFiles(config.reproducibility?.files ?? DEFAULT_REPRODUCIBILITY_FILES, repoRoot)
    },
    deployments: config.deployments.map((deployment, index) => deploymentEvidence(deployment, repoRoot, index)),
    attestations: cloneJson(config.attestations),
    checks: cloneJson(config.checks)
  };

  await validateDeploymentManifest(manifest, { root: repoRoot });
  return Object.freeze(manifest);
}

function deploymentEvidence(deployment, repoRoot, index) {
  const label = `deployments[${index}]`;
  assertObject(deployment, label);
  for (const key of ["name", "address", "artifact", "salt", "constructorArgs", "explorer", "receipt"]) {
    if (!(key in deployment)) throw new Error(`missing ${label}.${key}`);
  }
  assertRepoRelativePath(deployment.artifact, `${label}.artifact`);
  const artifactPath = join(repoRoot, deployment.artifact);
  if (!existsSync(artifactPath)) throw new Error(`${label}.artifact does not exist: ${deployment.artifact}`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const initCode = artifact.bytecode?.object;
  const runtimeCode = artifact.deployedBytecode?.object;
  if (!isHex(initCode) || !isHex(runtimeCode)) throw new Error(`${label}.artifact missing bytecode`);

  return Object.freeze({
    name: requireString(deployment.name, `${label}.name`),
    address: deployment.address,
    artifact: deployment.artifact,
    salt: deployment.salt,
    initCodeHash: hashHex(initCode),
    runtimeCodeHash: hashHex(runtimeCode),
    constructorArgs: cloneJson(deployment.constructorArgs),
    explorer: cloneJson(deployment.explorer),
    receipt: cloneJson(deployment.receipt)
  });
}

function reproducibilityFiles(files, repoRoot) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("reproducibility.files must be a non-empty array or path list");
  }
  return Object.freeze(files.map((item, index) => {
    const path = typeof item === "string" ? item : item?.path;
    const label = `reproducibility.files[${index}]`;
    assertRepoRelativePath(path, `${label}.path`);
    const fullPath = join(repoRoot, path);
    if (!existsSync(fullPath)) throw new Error(`${label}.path does not exist: ${path}`);
    return Object.freeze({
      path,
      hash: hashBytes(readFileSync(fullPath))
    });
  }));
}

function currentGitCommit(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error("build.gitCommit is required when git metadata is unavailable");
  return result.stdout.trim();
}

function assertRepoRelativePath(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  if (isAbsolute(value) || value.split(/[\\/]+/u).includes("..")) {
    throw new Error(`${label} must stay inside repository`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireString(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashHex(value) {
  return `0x${keccak_256(Buffer.from(value.slice(2), "hex"))}`;
}

function hashBytes(value) {
  return `0x${keccak_256(value)}`;
}

function isHex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value);
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath) {
    throw new Error("usage: node tools/build-deployment-manifest.mjs <config.json> [output.json]");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const manifest = await buildDeploymentManifest(config);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, text);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
