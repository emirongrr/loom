import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sha3 from "js-sha3";
import { manifestHash } from "@loom/core";
import { privateKeyToAccount } from "viem/accounts";
import {
  deploymentAttestationMessage,
  deploymentEvidenceDigest,
  validateDeploymentManifest
} from "./validate-deployment-manifest.mjs";

const { keccak_256 } = sha3;

/// Deliberately not the version this repository pins. The manifest tools read
/// the compiler out of `foundry.toml`, so a fixture that used the real pin
/// would still pass if they went back to hard-coding one.
const FIXTURE_SOLC_VERSION = "1.2.3";
const FIXTURE_FOUNDRY_TOML = `[profile.default]
solc_version = "${FIXTURE_SOLC_VERSION}"
`;

test("deployment manifest accepts verified artifact hashes and release checks", async () => {
  const root = await fixtureRoot();
  const manifest = await manifestFor(root);

  await validateDeploymentManifest(manifest, { root });
});

test("deployment manifest rejects bytecode hash mismatches", async () => {
  const root = await fixtureRoot();
  const manifest = await manifestFor(root);
  manifest.deployments[0].runtimeCodeHash = bytes32("bad-runtime");

  await assert.rejects(
    () => validateDeploymentManifest(manifest, { root }),
    /deployments\[0\]\.runtimeCodeHash mismatch/
  );
});

test("deployment manifest rejects missing chain and build verification", async () => {
  const root = await fixtureRoot();
  const manifest = await manifestFor(root);
  manifest.network.entryPointVersion = "0.8.0";
  await assert.rejects(() => validateDeploymentManifest(manifest, { root }), /entryPointVersion must be 0.9.0/);

  const badBuild = await manifestFor(root);
  badBuild.build.viaIR = false;
  await assert.rejects(() => validateDeploymentManifest(badBuild, { root }), /build.viaIR must be true/);

  const badCheck = await manifestFor(root);
  badCheck.checks.localBytecodeReproduction = false;
  await assert.rejects(
    () => validateDeploymentManifest(badCheck, { root }),
    /missing passing deployment check: localBytecodeReproduction/
  );
});

test("deployment manifest rejects missing finality and sender creator evidence", async () => {
  const root = await fixtureRoot();
  const missingFamily = await manifestFor(root);
  delete missingFamily.network.family;
  await assert.rejects(() => validateDeploymentManifest(missingFamily, { root }), /network.family/);

  const badFinality = await manifestFor(root);
  badFinality.network.finality = { kind: "op-stack-l1-finalized", minConfirmations: 1, l1ChainId: 10 };
  await assert.rejects(() => validateDeploymentManifest(badFinality, { root }), /l1ChainId must be Ethereum mainnet/);

  const missingSenderCreator = await manifestFor(root);
  delete missingSenderCreator.network.senderCreatorCodeHash;
  await assert.rejects(
    () => validateDeploymentManifest(missingSenderCreator, { root }),
    /network.senderCreatorCodeHash/
  );
});

test("deployment manifest rejects unsafe P-256 and duplicate deployment coordinates", async () => {
  const root = await fixtureRoot();
  const badP256 = await manifestFor(root);
  badP256.network.p256 = { kind: "unknown", address: address("p256") };
  await assert.rejects(() => validateDeploymentManifest(badP256, { root }), /p256.kind/);

  const unverifiedP256 = await manifestFor(root);
  unverifiedP256.network.p256.behaviorVerified = false;
  await assert.rejects(() => validateDeploymentManifest(unverifiedP256, { root }), /behaviorVerified must be true/);

  const duplicate = await manifestFor(root);
  duplicate.deployments.push({ ...duplicate.deployments[0], name: "Other" });
  await assert.rejects(() => validateDeploymentManifest(duplicate, { root }), /duplicate deployment coordinate/);
});

test("deployment manifest rejects missing deterministic and size checks", async () => {
  const root = await fixtureRoot();
  const missingDeterminism = await manifestFor(root);
  missingDeterminism.checks.deterministicAddressReproduction = false;
  await assert.rejects(
    () => validateDeploymentManifest(missingDeterminism, { root }),
    /missing passing deployment check: deterministicAddressReproduction/
  );

  const missingFactorySize = await manifestFor(root);
  delete missingFactorySize.checks.factoryRuntimeWithinEip170;
  await assert.rejects(
    () => validateDeploymentManifest(missingFactorySize, { root }),
    /missing passing deployment check: factoryRuntimeWithinEip170/
  );
});

test("deployment manifest rejects artifact paths outside the repository", async () => {
  const root = await fixtureRoot();
  const manifest = await manifestFor(root);
  manifest.deployments[0].artifact = "../out/Example.sol/Example.json";

  await assert.rejects(() => validateDeploymentManifest(manifest, { root }), /artifact must stay inside repository/);
});

test("deployment manifest rejects missing or mismatched reproducibility evidence", async () => {
  const root = await fixtureRoot();
  const missingCommand = await manifestFor(root);
  missingCommand.reproducibility.commands = missingCommand.reproducibility.commands.filter(
    item => item.name !== "manifest-check"
  );
  await assert.rejects(
    () => validateDeploymentManifest(missingCommand, { root }),
    /missing reproducibility command: manifest-check/
  );

  const badExit = await manifestFor(root);
  badExit.reproducibility.commands[0].exitCode = 1;
  await assert.rejects(
    () => validateDeploymentManifest(badExit, { root }),
    /reproducibility\.commands\[0\]\.exitCode must be 0/
  );

  const badFileHash = await manifestFor(root);
  badFileHash.reproducibility.files[0].hash = bytes32("wrong-file-hash");
  await assert.rejects(
    () => validateDeploymentManifest(badFileHash, { root }),
    /reproducibility\.files\[0\]\.hash mismatch/
  );
});

test("deployment manifest rejects failed receipts and secret-bearing explorer URLs", async () => {
  const root = await fixtureRoot();
  const failedReceipt = await manifestFor(root);
  failedReceipt.deployments[0].receipt.status = "0x0";
  await assert.rejects(
    () => validateDeploymentManifest(failedReceipt, { root }),
    /deployments\[0\]\.receipt\.status must be 0x1/
  );

  const missingReceipt = await manifestFor(root);
  delete missingReceipt.deployments[0].receipt.transactionHash;
  await assert.rejects(
    () => validateDeploymentManifest(missingReceipt, { root }),
    /deployments\[0\]\.receipt\.transactionHash/
  );

  const secretUrl = await manifestFor(root);
  secretUrl.deployments[0].explorer.url = "https://example.invalid/address?apikey=secret";
  await assert.rejects(
    () => validateDeploymentManifest(secretUrl, { root }),
    /must not contain secret-bearing query parameters/
  );
});

test("deployment manifest requires signed release attestations", async () => {
  const root = await fixtureRoot();
  const missing = await manifestFor(root);
  delete missing.attestations;
  await assert.rejects(() => validateDeploymentManifest(missing, { root }), /missing top-level manifest field: attestations/);

  const duplicateRole = await manifestFor(root);
  duplicateRole.attestations[1].role = "deployer";
  await assert.rejects(() => validateDeploymentManifest(duplicateRole, { root }), /duplicate attestation role/);

  const sharedSigner = await manifestFor(root);
  sharedSigner.attestations[1].signer = sharedSigner.attestations[0].signer;
  await assert.rejects(() => validateDeploymentManifest(sharedSigner, { root }), /signers must be distinct/);

  const badSignature = await manifestFor(root);
  badSignature.attestations[2].signature = "0x1234";
  await assert.rejects(() => validateDeploymentManifest(badSignature, { root }), /signature must be a 65-byte signature/);

  const forgedSignature = await manifestFor(root);
  forgedSignature.attestations[2].signature = forgedSignature.attestations[1].signature;
  await assert.rejects(
    () => validateDeploymentManifest(forgedSignature, { root }),
    /signature does not recover to signer/
  );

  const unrelatedDigest = await manifestFor(root);
  unrelatedDigest.attestations[1].manifestHash = bytes32("unrelated-evidence");
  await assert.rejects(
    () => validateDeploymentManifest(unrelatedDigest, { root }),
    /manifestHash must equal evidenceDigest/
  );
});

test("deployment evidence digest detects receipt tampering after signatures", async () => {
  const root = await fixtureRoot();
  const manifest = await manifestFor(root);
  manifest.deployments[0].receipt.blockNumber += 1;
  await assert.rejects(
    () => validateDeploymentManifest(manifest, { root }),
    /evidenceDigest does not match deployment evidence/
  );
});

test("deployment manifest requires a hash-bound canonical projection", async () => {
  const root = await fixtureRoot();

  const missing = await manifestFor(root);
  delete missing.canonical;
  await assert.rejects(() => validateDeploymentManifest(missing, { root }), /missing top-level manifest field: canonical/);

  const badHash = await manifestFor(root);
  badHash.canonical.manifestHash = bytes32("tampered");
  await assert.rejects(
    () => validateDeploymentManifest(badHash, { root }),
    /canonical.manifestHash does not match/
  );
});

test("deployment manifest rejects a canonical projection that drifts from the evidence", async () => {
  const root = await fixtureRoot();

  const driftedFactory = await manifestFor(root);
  driftedFactory.canonical.manifest.factory = {
    address: address("someone-else"),
    runtimeCodeHash: driftedFactory.canonical.manifest.factory.runtimeCodeHash
  };
  driftedFactory.canonical.manifestHash = manifestHash(driftedFactory.canonical.manifest);
  await assert.rejects(
    () => validateDeploymentManifest(driftedFactory, { root }),
    /canonical factory disagrees with deployment evidence/
  );

  const driftedProxy = await manifestFor(root);
  driftedProxy.canonical.manifest.account = {
    ...driftedProxy.canonical.manifest.account,
    proxy: { creationCodeHash: bytes32("not-the-artifact"), runtimeCodeHash: hashHex("0x6001") }
  };
  driftedProxy.canonical.manifestHash = manifestHash(driftedProxy.canonical.manifest);
  await assert.rejects(
    () => validateDeploymentManifest(driftedProxy, { root }),
    /canonical proxy hashes disagree/
  );
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
  await writeFile(join(root, "foundry.toml"), FIXTURE_FOUNDRY_TOML);
  await writeFile(join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  return root;
}

async function manifestFor(root) {
  const artifact = "out/Example.sol/Example.json";
  const base = {
    version: 1,
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
      sourceArchiveHash: bytes32("source"),
      solcVersion: FIXTURE_SOLC_VERSION,
      foundryVersion: "1.7.1",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "osaka"
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
      files: [
        { path: "foundry.toml", hash: hashText(FIXTURE_FOUNDRY_TOML) },
        { path: "package-lock.json", hash: hashText("{\"lockfileVersion\":3}\n") }
      ]
    },
    deployments: [
      {
        name: "Example",
        address: address("example"),
        artifact,
        deploymentMethod: { kind: "create", deployer: SIGNERS[0].address, nonce: 7 },
        initCodeHash: hashHex("0x60016002"),
        runtimeCodeHash: hashHex("0x6001"),
        constructorArgs: [address("entry-point")],
        explorer: {
          verified: true,
          url: "https://example.invalid/address"
        },
        receipt: {
          transactionHash: bytes32("deploy-tx"),
          deployer: SIGNERS[0].address,
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
    }
  };
  base.canonical = canonicalFor(base);
  base.evidenceDigest = deploymentEvidenceDigest(base);
  base.attestations = await Promise.all([
    attestation(base, "deployer", SIGNERS[0]),
    attestation(base, "independent-reproducer", SIGNERS[1]),
    attestation(base, "security-reviewer", SIGNERS[2])
  ]);
  return base;
}

// Mirrors the builder's projection so the fixture stays consistent by
// construction: the canonical manifest is derived from the same evidence
// values and hashed with @loom/core's manifestHash.
function canonicalFor(base) {
  const deployment = base.deployments[0];
  const entry = { address: deployment.address, runtimeCodeHash: deployment.runtimeCodeHash };
  const projected = {
    schemaVersion: "1",
    releaseChannel: "testnet",
    chainId: base.network.chainId,
    entryPoint: { address: base.network.entryPoint, runtimeCodeHash: base.network.entryPointCodeHash },
    factory: entry,
    account: {
      implementation: entry,
      proxy: { creationCodeHash: hashHex("0x60016002"), runtimeCodeHash: hashHex("0x6001") }
    },
    modules: [{ type: "validator", ...entry, version: "0.1.0", status: "beta" }],
    compatibility: { contractRelease: "0.1.0", sdkRange: "^0.1.0" }
  };
  return {
    manifest: projected,
    manifestHash: manifestHash(projected),
    proxyArtifact: "out/Example.sol/Example.json",
    sources: { factory: "Example", implementation: "Example", validator: "Example" }
  };
}

async function attestation(manifest, role, account) {
  const statement = `${role} verified the deployment manifest and release evidence.`;
  const signedAt = "2026-06-21";
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
