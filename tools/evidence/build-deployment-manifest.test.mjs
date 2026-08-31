import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sha3 from "js-sha3";
import { encodeDeployData, getContractAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildDeploymentManifest, prepareDeploymentManifest } from "./build-deployment-manifest.mjs";
import { deploymentAttestationMessage } from "./validate-deployment-manifest.mjs";

const { keccak_256 } = sha3;

/// Deliberately not the version this repository pins. The manifest tools read
/// the compiler out of `foundry.toml`, so a fixture that used the real pin
/// would still pass if they went back to hard-coding one.
const FIXTURE_SOLC_VERSION = "1.2.3";
const FIXTURE_FOUNDRY_TOML = `[profile.default]
solc_version = "${FIXTURE_SOLC_VERSION}"
`;

test("the builder embeds a hash-bound canonical projection of the evidence", async () => {
  const root = await fixtureRoot();
  const manifest = await buildDeploymentManifest(await signedConfigFor(root), { root });

  assert.equal(manifest.canonical.manifest.schemaVersion, "1");
  assert.equal(manifest.canonical.manifest.chainId, manifest.network.chainId);
  assert.equal(manifest.canonical.manifest.factory.address, manifest.deployments[0].address);
  assert.equal(manifest.canonical.manifest.factory.runtimeCodeHash, manifest.deployments[0].runtimeCodeHash);
  assert.equal(manifest.canonical.manifest.entryPoint.runtimeCodeHash, manifest.network.entryPointCodeHash);
  assert.match(manifest.canonical.manifestHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(manifest.canonical.sources, {
    factory: "Example",
    implementation: "Example",
    validator: "Example"
  });
});

test("deployment manifest builder computes artifact and reproducibility hashes", async () => {
  const root = await fixtureRoot();
  const manifest = await buildDeploymentManifest(await signedConfigFor(root), { root });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.build.gitCommit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(manifest.deployments[0].initCodeHash, hashHex(fixtureInitCode()));
  assert.equal(manifest.deployments[0].runtimeCodeHash, hashHex("0x6001"));
  assert.deepEqual(manifest.reproducibility.files, [
    { path: "foundry.toml", hash: hashText(FIXTURE_FOUNDRY_TOML) },
    { path: "package-lock.json", hash: hashText("{\"lockfileVersion\":3}\n") }
  ]);
});

test("deployment manifest builder validates before writing release evidence", async () => {
  const root = await fixtureRoot();
  const config = await signedConfigFor(root);
  config.deployments[0].artifact = "../out/Example.sol/Example.json";
  await assert.rejects(() => buildDeploymentManifest(config, { root }), /artifact must stay inside repository/);

  const badExit = await signedConfigFor(root);
  badExit.reproducibility.commands[1].exitCode = 1;
  await assert.rejects(() => buildDeploymentManifest(badExit, { root }), /exitCode must be 0/);

  const badExplorer = await signedConfigFor(root);
  badExplorer.deployments[0].explorer.url = "https://explorer.example/address?apikey=secret";
  await assert.rejects(() => buildDeploymentManifest(badExplorer, { root }), /secret-bearing query/);
});

test("deployment manifest builder requires real deployment inputs", async () => {
  const root = await fixtureRoot();
  const missingReceipt = await signedConfigFor(root);
  delete missingReceipt.deployments[0].receipt.transactionHash;
  await assert.rejects(() => buildDeploymentManifest(missingReceipt, { root }), /receipt\.transactionHash/);

  const missingAttestations = await signedConfigFor(root);
  missingAttestations.attestations.pop();
  await assert.rejects(() => buildDeploymentManifest(missingAttestations, { root }), /attestations must include/);
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-deployment-manifest-builder-"));
  const artifactDir = join(root, "out", "Example.sol");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "Example.json"), JSON.stringify({
    abi: [{ type: "constructor", inputs: [{ name: "entryPoint", type: "address" }], stateMutability: "nonpayable" }],
    bytecode: { object: "0x60016002" },
    deployedBytecode: { object: "0x6001" }
  }));
  await writeFile(join(root, "foundry.toml"), FIXTURE_FOUNDRY_TOML);
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
      entryPointExplorer: "https://explorer.example/address/entry-point",
      senderCreator: address("sender-creator"),
      senderCreatorCodeHash: bytes32("sender-creator-code"),
      senderCreatorExplorer: "https://explorer.example/address/sender-creator",
      referenceBlock: 123,
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
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
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
        address: fixtureDeploymentAddress(),
        artifact: "out/Example.sol/Example.json",
        deploymentMethod: { kind: "create", deployer: SIGNERS[0].address, nonce: 7 },
        constructorArgs: [address("entry-point")],
        explorer: {
          verified: true,
          url: "https://explorer.example/address"
        },
        receipt: {
          transactionHash: bytes32("deploy-tx"),
          blockHash: bytes32("deploy-block"),
          deployer: SIGNERS[0].address,
          contractAddress: fixtureDeploymentAddress(),
          blockNumber: 123,
          status: "0x1",
          gasUsed: 500000
        }
      }
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
    },
    canonical: {
      factory: "Example",
      implementation: "Example",
      validator: "Example",
      proxyArtifact: "out/Example.sol/Example.json",
      compatibility: { contractRelease: "0.1.0", sdkRange: "^0.1.0" }
    }
  };
}

async function signedConfigFor(root) {
  const config = configFor(root);
  const draft = await prepareDeploymentManifest(config, { root });
  config.attestations = await Promise.all([
    attestation(draft, "deployer", SIGNERS[0]),
    attestation(draft, "independent-reproducer", SIGNERS[1]),
    attestation(draft, "security-reviewer", SIGNERS[2])
  ]);
  return config;
}

async function attestation(manifest, role, account) {
  const signedAt = "2026-07-07";
  const statement = `${role} verified the deployment manifest and release evidence.`;
  return {
    role,
    signer: account.address,
    manifestHash: manifest.evidenceDigest,
    signature: await account.signMessage({ message: deploymentAttestationMessage({
      role,
      chainId: manifest.network.chainId,
      manifestHash: manifest.evidenceDigest,
      signedAt,
      statement
    }) }),
    signedAt,
    statement
  };
}

const SIGNERS = [
  privateKeyToAccount(`0x${"11".repeat(32)}`),
  privateKeyToAccount(`0x${"22".repeat(32)}`),
  privateKeyToAccount(`0x${"33".repeat(32)}`)
];

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

function fixtureInitCode() {
  return encodeDeployData({
    abi: [{ type: "constructor", inputs: [{ name: "entryPoint", type: "address" }], stateMutability: "nonpayable" }],
    bytecode: "0x60016002",
    args: [address("entry-point")]
  });
}

function fixtureDeploymentAddress() {
  return getContractAddress({ from: SIGNERS[0].address, nonce: 7n });
}
