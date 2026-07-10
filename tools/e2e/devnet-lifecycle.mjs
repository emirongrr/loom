// Hermetic end-to-end Loom lifecycle on a local devnet — contracts only.
//
//   npm run e2e:devnet
//
// This is a full black-box exercise of Loom with no app, no bundler, and no
// SDK runtime in the account path:
//
//   1. Start a fresh anvil devnet (deterministic, isolated, torn down after).
//   2. Probe the live EIP-7951 P-256 precompile so native mode is evidence
//      backed on this node exactly as production requires.
//   3. Deploy the full Loom stack with DeployDevnet (real broadcast).
//   4. Verify the deployment against the live chain with @loom/deployment:
//      parse the broadcast, read bytecode, compute code hashes, re-probe.
//   5. Generate a fresh software P-256 key and run DevnetAccountLifecycle:
//      create a LoomAccount through EntryPoint.handleOps with a WebAuthn
//      signature, execute a call, then execute a second call on the deployed
//      account. The script asserts on-chain state after each broadcast.
//
// Every failure is fatal and the devnet is always torn down.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJsonRpcClient,
  parseFoundryBroadcast,
  probeP256Precompile
} from "../../packages/deployment/src/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
// anvil's first deterministic dev account (well-known, devnet only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}

function fail(message) {
  console.error(`\nFAIL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function waitForRpc(rpc, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  fail("anvil did not become reachable");
}

function forgeScript(scriptTarget, env) {
  const result = spawnSync(
    bin("forge"),
    ["script", scriptTarget, "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation"],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } }
  );
  if (result.status !== 0) fail(`${scriptTarget} exited with code ${result.status}`);
}

function softwareP256Key() {
  // Fresh P-256 keypair; identical envelope to a device passkey, but held in
  // software so CI needs no authenticator. Devnet only.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = privateKey.export({ format: "jwk" });
  return {
    privateKey: `0x${Buffer.from(raw.d, "base64url").toString("hex")}`,
    x: `0x${Buffer.from(jwk.x, "base64url").toString("hex")}`,
    y: `0x${Buffer.from(jwk.y, "base64url").toString("hex")}`
  };
}

let anvil;

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);

  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], {
    cwd: repoRoot,
    stdio: "ignore"
  });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  await waitForRpc(rpc);

  console.log("==> Probing the native EIP-7951 P-256 precompile");
  const probe = await probeP256Precompile(rpc);
  if (!probe.supported) fail(`devnet P-256 precompile probe failed (valid=${probe.valid}, invalid=${probe.invalid})`);
  console.log("    native precompile verifies valid vectors and rejects corrupted ones");

  console.log("==> Deploying the Loom stack (DeployDevnet)");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });

  const broadcastPath = join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json");
  if (!existsSync(broadcastPath)) fail(`deploy broadcast missing: ${broadcastPath}`);
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));

  console.log("==> Verifying the deployment with @loom/deployment");
  const parsed = parseFoundryBroadcast(broadcast);
  for (const [label, address] of Object.entries(parsed.addresses)) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (!code || code === "0x") fail(`${label} at ${address} has no code on the devnet`);
    console.log(`    ok  ${label} deployed with live bytecode — ${address}`);
  }

  const created = parsed.createdContracts;
  const need = name => {
    const address = created[name];
    if (!address) fail(`deployment is missing ${name}`);
    return address;
  };

  const key = softwareP256Key();
  console.log("==> Running the account lifecycle (DevnetAccountLifecycle)");
  forgeScript("script/DevnetAccountLifecycle.s.sol:DevnetAccountLifecycle", {
    DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY,
    DEVNET_ENTRYPOINT: need("EntryPoint"),
    DEVNET_FACTORY: need("LoomAccountFactory"),
    DEVNET_P256_VALIDATOR: need("P256Validator"),
    DEVNET_POLICY_HOOK: need("PolicyHook"),
    DEVNET_TARGET: need("DevnetTarget"),
    DEVNET_P256_PRIVATE_KEY: key.privateKey,
    DEVNET_P256_X: key.x,
    DEVNET_P256_Y: key.y
  });

  console.log("\nE2E devnet lifecycle passed: deployed, verified, account created, two operations executed.");
}

try {
  await main();
} finally {
  if (anvil && !anvil.killed) anvil.kill();
}
