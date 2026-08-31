import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContractAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareDeploymentAttestations } from "./prepare-deployment-attestations.mjs";

test("prepares one common digest and exact messages for the three release roles", async () => {
  const root = await fixtureRoot();
  const deployer = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
  const result = await prepareDeploymentAttestations(config(deployer), { root });

  assert.match(result.evidenceDigest, /^0x[0-9a-f]{64}$/u);
  assert.deepEqual(result.attestations.map(item => item.role), [
    "deployer",
    "independent-reproducer",
    "security-reviewer"
  ]);
  assert.ok(result.attestations.every(item => item.manifestHash === result.evidenceDigest));
  assert.match(result.attestations[2].message, /security-reviewer/u);
});

test("refuses a deployer attestation key unrelated to the receipts", async () => {
  const root = await fixtureRoot();
  const actual = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
  const candidate = config(actual);
  candidate.attestations[0].signer = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
  await assert.rejects(
    () => prepareDeploymentAttestations(candidate, { root }),
    /must match every deployment receipt deployer/u
  );
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-attestation-payload-"));
  await mkdir(join(root, "out", "Example.sol"), { recursive: true });
  await writeFile(join(root, "out", "Example.sol", "Example.json"), JSON.stringify({
    bytecode: { object: "0x60016002" },
    deployedBytecode: { object: "0x6001" }
  }));
  await writeFile(join(root, "foundry.toml"), '[profile.default]\nsolc_version = "1.2.3"\n');
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return root;
}

function config(deployer) {
  const address = seed => `0x${seed.repeat(40).slice(0, 40)}`;
  const hash = seed => `0x${seed.repeat(64).slice(0, 64)}`;
  const roles = ["deployer", "independent-reproducer", "security-reviewer"];
  const signers = [
    deployer,
    privateKeyToAccount(`0x${"22".repeat(32)}`).address,
    privateKeyToAccount(`0x${"33".repeat(32)}`).address
  ];
  const deploymentAddress = getContractAddress({ from: deployer, nonce: 7n });
  return {
    network: {
      name: "sepolia", family: "ethereum", chainId: 11155111,
      entryPoint: address("1"), entryPointVersion: "0.9.0", entryPointCodeHash: hash("1"),
      entryPointExplorer: "https://explorer.example/address/entry-point",
      senderCreator: address("2"), senderCreatorCodeHash: hash("2"),
      senderCreatorExplorer: "https://explorer.example/address/sender-creator", referenceBlock: 123,
      finality: { kind: "ethereum-finalized", minConfirmations: 2 },
      p256: { kind: "precompile", address: address("3"), behaviorVerified: true }
    },
    build: { gitCommit: "0123456789abcdef0123456789abcdef01234567", sourceArchiveHash: hash("4") },
    reproducibility: {
      commands: ["install", "build", "verify", "manifest-check"].map(name => ({ name, command: name, exitCode: 0 })),
      files: ["foundry.toml", "package-lock.json"]
    },
    deployments: [{
      name: "Example", address: deploymentAddress, artifact: "out/Example.sol/Example.json",
      deploymentMethod: { kind: "create", deployer, nonce: 7 }, constructorArgs: [],
      explorer: { verified: true, url: "https://example.invalid/address" },
      receipt: {
        transactionHash: hash("5"), blockHash: hash("6"), deployer,
        contractAddress: deploymentAddress, blockNumber: 123, status: "0x1", gasUsed: 500000
      }
    }],
    attestations: roles.map((role, index) => ({
      role, signer: signers[index], signedAt: "2026-08-27",
      statement: `${role} independently reviewed this exact evidence digest.`
    })),
    checks: {
      cleanCheckoutBuild: true, localBytecodeReproduction: true, entryPointBytecodeVerified: true,
      senderCreatorBytecodeVerified: true, p256BehaviorVerified: true, explorerSourceVerified: true,
      deterministicAddressReproduction: true, factoryRuntimeWithinEip170: true,
      noAdminOrUpgradeKey: true, noLoomServiceRequired: true
    },
    canonical: {
      factory: "Example", implementation: "Example", validator: "Example",
      proxyArtifact: "out/Example.sol/Example.json",
      compatibility: { contractRelease: "0.1.0", sdkRange: "^0.1.0" }
    }
  };
}
