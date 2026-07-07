import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sha3 from "js-sha3";
import { buildDeploymentManifest } from "./build-deployment-manifest.mjs";

const { keccak_256 } = sha3;

test("deployment manifest builder computes artifact and reproducibility hashes", async () => {
  const root = await fixtureRoot();
  const manifest = await buildDeploymentManifest(configFor(root), { root });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.build.gitCommit, "0123456789abcdef");
  assert.equal(manifest.deployments[0].initCodeHash, hashHex("0x60016002"));
  assert.equal(manifest.deployments[0].runtimeCodeHash, hashHex("0x6001"));
  assert.deepEqual(manifest.reproducibility.files, [
    { path: "foundry.toml", hash: hashText("[profile.default]\nsolc = \"0.8.35\"\n") },
    { path: "package-lock.json", hash: hashText("{\"lockfileVersion\":3}\n") }
  ]);
});

test("deployment manifest builder validates before writing release evidence", async () => {
  const root = await fixtureRoot();
  const config = configFor(root);
  config.deployments[0].artifact = "../out/Example.sol/Example.json";
  await assert.rejects(() => buildDeploymentManifest(config, { root }), /artifact must stay inside repository/);

  const badExit = configFor(root);
  badExit.reproducibility.commands[1].exitCode = 1;
  await assert.rejects(() => buildDeploymentManifest(badExit, { root }), /exitCode must be 0/);

  const badExplorer = configFor(root);
  badExplorer.deployments[0].explorer.url = "https://explorer.example/address?apikey=secret";
  await assert.rejects(() => buildDeploymentManifest(badExplorer, { root }), /secret-bearing query/);
});

test("deployment manifest builder requires real deployment inputs", async () => {
  const root = await fixtureRoot();
  const missingReceipt = configFor(root);
  delete missingReceipt.deployments[0].receipt.transactionHash;
  await assert.rejects(() => buildDeploymentManifest(missingReceipt, { root }), /receipt\.transactionHash/);

  const missingAttestations = configFor(root);
  missingAttestations.attestations.pop();
  await assert.rejects(() => buildDeploymentManifest(missingAttestations, { root }), /attestations must include/);
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-deployment-manifest-builder-"));
  const artifactDir = join(root, "out", "Example.sol");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "Example.json"), JSON.stringify({
    bytecode: { object: "0x60016002" },
    deployedBytecode: { object: "0x6001" }
  }));
  await writeFile(join(root, "foundry.toml"), "[profile.default]\nsolc = \"0.8.35\"\n");
  await writeFile(join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  return root;
}

function configFor() {
  return {
    network: {
      name: "sepolia",
      family: "ethereum",
      chainId: 11155111,
      entryPoint: address("entry-point"),
      entryPointVersion: "0.9.0",
      entryPointCodeHash: bytes32("entry-point-code"),
      senderCreator: address("sender-creator"),
      senderCreatorCodeHash: bytes32("sender-creator-code"),
      finality: {
        kind: "ethereum-finalized",
        minConfirmations: 2
      },
      p256: {
        kind: "precompile",
        address: address("p256"),
        behaviorVerified: true
      }
    },
    build: {
      gitCommit: "0123456789abcdef",
      sourceArchiveHash: bytes32("source")
    },
    reproducibility: {
      commands: [
        { name: "install", command: "npm ci", exitCode: 0 },
        { name: "build", command: "forge build --sizes", exitCode: 0 },
        { name: "verify", command: "npm run verify:quick", exitCode: 0 },
        {
          name: "manifest-check",
          command: "npm run deployment:manifest:check -- evidence/deployments/sepolia.json",
          exitCode: 0
        }
      ],
      files: ["foundry.toml", "package-lock.json"]
    },
    deployments: [
      {
        name: "Example",
        address: address("example"),
        artifact: "out/Example.sol/Example.json",
        salt: bytes32("salt"),
        constructorArgs: [address("entry-point")],
        explorer: {
          verified: true,
          url: "https://explorer.example/address"
        },
        receipt: {
          transactionHash: bytes32("deploy-tx"),
          deployer: address("deployer"),
          blockNumber: 123,
          status: "0x1",
          gasUsed: 500000
        }
      }
    ],
    attestations: [
      attestation("deployer", "0xDeployerKey"),
      attestation("independent-reproducer", "0xReproducerKey"),
      attestation("security-reviewer", "0xReviewerKey")
    ],
    checks: {
      cleanCheckoutBuild: true,
      localBytecodeReproduction: true,
      entryPointBytecodeVerified: true,
      senderCreatorBytecodeVerified: true,
      p256BehaviorVerified: true,
      explorerSourceVerified: true,
      deterministicAddressReproduction: true,
      factoryRuntimeWithinEip170: true,
      noAdminOrUpgradeKey: true,
      noLoomServiceRequired: true
    }
  };
}

function attestation(role, signer) {
  return {
    role,
    signer,
    manifestHash: bytes32(`manifest-${role}`),
    signature: `0x${"aa".repeat(65)}`,
    signedAt: "2026-07-07",
    statement: `${role} verified the deployment manifest and release evidence.`
  };
}

function hashHex(value) {
  return `0x${keccak_256(Buffer.from(value.slice(2), "hex"))}`;
}

function hashText(value) {
  return `0x${keccak_256(Buffer.from(value, "utf8"))}`;
}

function address(seed) {
  return `0x${keccak_256(seed).slice(0, 40)}`;
}

function bytes32(seed) {
  return `0x${keccak_256(seed)}`;
}
