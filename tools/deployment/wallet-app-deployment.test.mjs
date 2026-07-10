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
} from "./wallet-app-deployment.mjs";

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
