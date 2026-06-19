import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sha3 from "js-sha3";
import { validateDeploymentManifest } from "./validate-deployment-manifest.mjs";

const { keccak_256 } = sha3;

test("deployment manifest accepts verified artifact hashes and release checks", async () => {
  const root = await fixtureRoot();
  const manifest = manifestFor(root);

  await validateDeploymentManifest(manifest, { root });
});

test("deployment manifest rejects bytecode hash mismatches", async () => {
  const root = await fixtureRoot();
  const manifest = manifestFor(root);
  manifest.deployments[0].runtimeCodeHash = bytes32("bad-runtime");

  await assert.rejects(
    () => validateDeploymentManifest(manifest, { root }),
    /deployments\[0\]\.runtimeCodeHash mismatch/
  );
});

test("deployment manifest rejects missing chain and build verification", async () => {
  const root = await fixtureRoot();
  const manifest = manifestFor(root);
  manifest.network.entryPointVersion = "0.8.0";
  await assert.rejects(() => validateDeploymentManifest(manifest, { root }), /entryPointVersion must be 0.9.0/);

  const badBuild = manifestFor(root);
  badBuild.build.viaIR = false;
  await assert.rejects(() => validateDeploymentManifest(badBuild, { root }), /build.viaIR must be true/);

  const badCheck = manifestFor(root);
  badCheck.checks.localBytecodeReproduction = false;
  await assert.rejects(
    () => validateDeploymentManifest(badCheck, { root }),
    /missing passing deployment check: localBytecodeReproduction/
  );
});

test("deployment manifest rejects unsafe P-256 and duplicate salts", async () => {
  const root = await fixtureRoot();
  const badP256 = manifestFor(root);
  badP256.network.p256 = { kind: "unknown", address: address("p256") };
  await assert.rejects(() => validateDeploymentManifest(badP256, { root }), /p256.kind/);

  const duplicate = manifestFor(root);
  duplicate.deployments.push({ ...duplicate.deployments[0], name: "Other" });
  await assert.rejects(() => validateDeploymentManifest(duplicate, { root }), /duplicate deployment salt/);
});

test("deployment manifest rejects artifact paths outside the repository", async () => {
  const root = await fixtureRoot();
  const manifest = manifestFor(root);
  manifest.deployments[0].artifact = "../out/Example.sol/Example.json";

  await assert.rejects(() => validateDeploymentManifest(manifest, { root }), /artifact must stay inside repository/);
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-deployment-manifest-"));
  const artifactDir = join(root, "out", "Example.sol");
  await mkdir(artifactDir, { recursive: true });
  const artifact = {
    bytecode: { object: "0x60016002" },
    deployedBytecode: { object: "0x6001" }
  };
  await writeFile(join(artifactDir, "Example.json"), JSON.stringify(artifact, null, 2));
  return root;
}

function manifestFor(root) {
  const artifact = "out/Example.sol/Example.json";
  return {
    version: 1,
    network: {
      name: "sepolia",
      chainId: 11155111,
      entryPoint: address("entry-point"),
      entryPointVersion: "0.9.0",
      entryPointCodeHash: bytes32("entry-point-code"),
      p256: {
        kind: "precompile",
        address: address("p256"),
        behaviorVerified: true
      }
    },
    build: {
      gitCommit: "0123456789abcdef",
      sourceArchiveHash: bytes32("source"),
      solcVersion: "0.8.35",
      foundryVersion: "1.7.1",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "osaka"
    },
    deployments: [
      {
        name: "Example",
        address: address("example"),
        artifact,
        salt: bytes32("salt"),
        initCodeHash: hashHex("0x60016002"),
        runtimeCodeHash: hashHex("0x6001"),
        constructorArgs: [address("entry-point")],
        explorer: {
          verified: true,
          url: "https://example.invalid/address"
        }
      }
    ],
    checks: {
      cleanCheckoutBuild: true,
      localBytecodeReproduction: true,
      entryPointBytecodeVerified: true,
      p256BehaviorVerified: true,
      explorerSourceVerified: true,
      noAdminOrUpgradeKey: true,
      noLoomServiceRequired: true
    }
  };
}

function hashHex(value) {
  return `0x${keccak_256(Buffer.from(value.slice(2), "hex"))}`;
}

function address(seed) {
  return `0x${keccak_256(seed).slice(0, 40)}`;
}

function bytes32(seed) {
  return `0x${keccak_256(seed)}`;
}
