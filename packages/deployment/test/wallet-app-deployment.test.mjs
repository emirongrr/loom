import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jsSha3 from "js-sha3";
import {
  buildWalletDeploymentManifest,
  connectWalletAppDeployment,
  envForWalletDeployment,
  parseFoundryBroadcast,
  verifyWalletDeploymentFiles
} from "../src/index.js";

const { keccak256 } = jsSha3;
const ENTRYPOINT = address("entrypoint");
const FACTORY = address("factory");
const P256 = address("p256");
const ACCOUNT = address("account");

test("parses a Foundry broadcast into wallet deployment components", () => {
  const parsed = parseFoundryBroadcast(broadcast());
  assert.equal(parsed.chainId, 11155111);
  assert.deepEqual(parsed.addresses, {
    accountFactory: FACTORY,
    passkeyValidator: P256,
    accountImplementation: ACCOUNT
  });
});

test("builds a manifest from chain code, not from broadcast trust", async () => {
  const manifest = await buildWalletDeploymentManifest({
    broadcast: broadcast(),
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    probeP256: async () => ({ supported: true })
  });

  assert.equal(manifest.accountFactory, FACTORY);
  assert.equal(manifest.p256VerifierMode, "native-precompile");
  assert.equal(manifest.codehashes.accountFactory, codehash("factory-code"));
  assert.equal(manifest.codehashes.passkeyValidator, codehash("p256-code"));
  assert.equal(manifest.codehashes.accountImplementation, codehash("account-code"));
});

test("writes env-compatible values and verifies env manifest chain agreement", async () => {
  const root = await fixtureRoot();
  await connectWalletAppDeployment({
    broadcastPath: join(root, "broadcast.json"),
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    manifestReference: "deployment/sepolia.manifest.json",
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    probeP256: async () => ({ supported: true })
  });

  const verification = await verifyWalletDeploymentFiles({
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    rpc: rpcFor(),
    accountImplementation: ACCOUNT,
    probeP256: async () => ({ supported: true })
  });
  assert.equal(verification.failures.length, 0);
  assert.equal(verification.env.EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST, "deployment/sepolia.manifest.json");
});

test("reports changed app values instead of silently accepting drift", async () => {
  const manifest = {
    chainId: 11155111,
    entryPoint: ENTRYPOINT,
    accountFactory: FACTORY,
    passkeyValidator: P256,
    p256Verifier: address("native"),
    p256VerifierMode: "native-precompile",
    codehashes: {
      accountFactory: codehash("factory-code"),
      passkeyValidator: codehash("p256-code"),
      accountImplementation: codehash("account-code")
    }
  };
  assert.equal(envForWalletDeployment(manifest, "deployment/sepolia.manifest.json").EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY, FACTORY);

  const root = await fixtureRoot();
  await writeFile(join(root, "deployment", "sepolia.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, ".env.local"), [
    "EXPO_PUBLIC_LOOM_CHAIN_ID=11155111",
    "EXPO_PUBLIC_LOOM_L1_CHAIN_ID=11155111",
    `EXPO_PUBLIC_LOOM_ENTRYPOINT=${ENTRYPOINT}`,
    `EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY=${address("wrong-factory")}`,
    `EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR=${P256}`,
    "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE=native-precompile",
    `EXPO_PUBLIC_LOOM_P256_VERIFIER=${address("native")}`,
    "EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST=deployment/sepolia.manifest.json",
    ""
  ].join("\n"));

  const verification = await verifyWalletDeploymentFiles({
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    rpc: rpcFor(),
    accountImplementation: ACCOUNT,
    probeP256: async () => ({ supported: true })
  });
  assert.match(verification.failures.map(item => item.label).join("\n"), /env factory == manifest/);
});

test("rejects missing broadcast components and missing chain code", async () => {
  const missing = broadcast().transactions.filter(tx => tx.contractName !== "P256Validator");
  assert.throws(() => parseFoundryBroadcast({ chain: 11155111, transactions: missing }), /P256Validator/);

  await assert.rejects(
    () => buildWalletDeploymentManifest({
      broadcast: broadcast(),
      rpc: async () => "0x",
      entryPoint: ENTRYPOINT,
      probeP256: async () => ({ supported: true })
    }),
    /has no code on chain/
  );
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-wallet-deployment-"));
  await mkdir(join(root, "deployment"), { recursive: true });
  await writeFile(join(root, "broadcast.json"), `${JSON.stringify(broadcast(), null, 2)}\n`);
  await writeFile(join(root, ".env.local"), "EXPO_PUBLIC_LOOM_RPC_URL=\n");
  return root;
}

function rpcFor() {
  const codes = new Map([
    [ENTRYPOINT.toLowerCase(), "entrypoint-code"],
    [FACTORY.toLowerCase(), "factory-code"],
    [P256.toLowerCase(), "p256-code"],
    [ACCOUNT.toLowerCase(), "account-code"]
  ]);
  return async (method, params) => {
    assert.equal(method, "eth_getCode");
    return hexText(codes.get(String(params[0]).toLowerCase()) ?? "");
  };
}

function broadcast() {
  return {
    chain: 11155111,
    commit: "0123456789abcdef",
    transactions: [
      { transactionType: "CREATE", contractName: "LoomAccountFactory", contractAddress: FACTORY },
      { transactionType: "CREATE", contractName: "P256Validator", contractAddress: P256 },
      { transactionType: "CREATE", contractName: "LoomAccount", contractAddress: ACCOUNT }
    ]
  };
}

function codehash(text) {
  return `0x${keccak256(Buffer.from(hexText(text).slice(2), "hex"))}`;
}

function hexText(text) {
  return `0x${Buffer.from(text, "utf8").toString("hex")}`;
}

function address(seed) {
  return `0x${keccak256(seed).slice(0, 40)}`;
}

test("p256 probe accepts only a 1-for-valid, empty-for-corrupted precompile", async () => {
  const { probeP256Precompile } = await import("../src/index.js");
  const ONE = `0x${"0".repeat(63)}1`;

  let calls = 0;
  const healthy = await probeP256Precompile(async (method, params) => {
    assert.equal(method, "eth_call");
    assert.equal(params[0].to, "0x0000000000000000000000000000000000000100");
    // First call carries the valid vector, second the corrupted one.
    return calls++ === 0 ? ONE : "0x";
  });
  assert.equal(healthy.supported, true);

  const alwaysOne = await probeP256Precompile(async () => ONE);
  assert.equal(alwaysOne.supported, false, "a precompile that accepts corrupted signatures must be rejected");

  const dead = await probeP256Precompile(async () => "0x");
  assert.equal(dead.supported, false, "an absent precompile must be rejected");
});

test("deployment records round-trip per network and reject unknown schemas", async () => {
  const { saveDeploymentRecord, loadDeploymentRecord, MANIFEST_SCHEMA_VERSION } = await import("../src/index.js");
  const directory = await mkdtemp(join(tmpdir(), "loom-deploy-record-"));
  const manifest = { chainId: 11155111, deployedAt: "2026-07-10T00:00:00.000Z", sourceCommit: "abc" };
  const parsed = {
    createdContracts: { LoomAccountFactory: FACTORY },
    transactionHashes: { LoomAccountFactory: "0x1234" }
  };

  const { recordPath, record } = await saveDeploymentRecord({ directory, manifest, parsed });
  assert.match(recordPath, /11155111\.json$/);
  assert.equal(record.schemaVersion, MANIFEST_SCHEMA_VERSION);

  const loaded = await loadDeploymentRecord({ directory, chainId: 11155111 });
  assert.equal(loaded.contracts.LoomAccountFactory, FACTORY);
  assert.equal(loaded.transactionHashes.LoomAccountFactory, "0x1234");
  assert.equal(await loadDeploymentRecord({ directory, chainId: 1 }), undefined);

  await writeFile(join(directory, "5.json"), JSON.stringify({ schemaVersion: 999 }));
  await assert.rejects(loadDeploymentRecord({ directory, chainId: 5 }), /schema 999/);
});

test("foundry runner fails closed on non-zero exit and missing broadcast", async () => {
  const { runFoundryDeployment } = await import("../src/index.js");
  const fakeSpawn = exitCode => () => ({
    on(event, handler) {
      if (event === "exit") setImmediate(() => handler(exitCode));
    }
  });

  await assert.rejects(
    runFoundryDeployment({
      repoRoot: tmpdir(),
      script: "script/DeploySepolia.s.sol:DeploySepolia",
      rpcUrl: "https://rpc.example",
      chainId: 11155111,
      forgeBin: "forge",
      spawn: fakeSpawn(1)
    }),
    /exited with code 1/
  );

  await assert.rejects(
    runFoundryDeployment({
      repoRoot: tmpdir(),
      script: "script/DeploySepolia.s.sol:DeploySepolia",
      rpcUrl: "https://rpc.example",
      chainId: 11155111,
      forgeBin: "forge",
      spawn: fakeSpawn(0)
    }),
    /broadcast is missing/
  );
});

test("deployment gas report attributes CREATE gas by transaction hash", async () => {
  const { deploymentGasReport } = await import("../src/index.js");
  const broadcast = {
    transactions: [
      { transactionType: "CREATE", contractName: "Factory", contractAddress: FACTORY, hash: "0xAA" },
      { transactionType: "CALL", contractName: "Factory", hash: "0xBB" },
      { transactionType: "CREATE", contractName: "Helper", contractAddress: ACCOUNT, hash: "0xCC" }
    ],
    // Deliberately out of order to prove hash-matching, not index-matching.
    receipts: [
      { transactionHash: "0xcc", gasUsed: "0x2710" },
      { transactionHash: "0xaa", gasUsed: "0x3e8" },
      { transactionHash: "0xbb", gasUsed: "0xffff" }
    ]
  };

  const all = deploymentGasReport(broadcast);
  assert.deepEqual(all.contracts.map(c => [c.contractName, c.gasUsed]), [["Factory", 1000], ["Helper", 10000]]);
  assert.equal(all.totalGas, 11000, "only CREATE gas is summed");

  const excluded = deploymentGasReport(broadcast, { exclude: ["Helper"] });
  assert.deepEqual(excluded.contracts.map(c => c.contractName), ["Factory"]);
  assert.equal(excluded.totalGas, 1000);
});
