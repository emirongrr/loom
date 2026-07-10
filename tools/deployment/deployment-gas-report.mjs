// Per-contract deployment gas for the Loom stack.
//
//   npm run deployment:gas
//
// Deploys the full stack once to a throwaway anvil devnet and reports the real
// gas each contract's deployment cost, read from the Foundry broadcast
// receipts. gasUsed is the computational cost of deploying the bytecode, so
// these numbers are the same on Sepolia and mainnet — only the gas price
// differs. This is separate from the E2E lifecycle test and does not touch it.

import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, deploymentGasReport } from "../../packages/deployment/src/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
// anvil's first deterministic dev account (well-known, devnet only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// EntryPoint is the vendored ERC-4337 singleton (not a Loom contract) and
// DevnetTarget is a test-only call target; neither is part of a Loom
// production deployment, so they are excluded from the reported total.
const NON_PRODUCTION = ["EntryPoint", "DevnetTarget"];

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}

function fail(message) {
  console.error(`\nFAIL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function waitForRpc(rpc) {
  for (let i = 0; i < 60; i++) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  fail("anvil did not become reachable");
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

  console.log("==> Deploying the Loom stack (DeployDevnet)");
  const deploy = spawnSync(
    bin("forge"),
    ["script", "script/DeployDevnet.s.sol:DeployDevnet", "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation"],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY } }
  );
  if (deploy.status !== 0) fail(`deployment exited with code ${deploy.status}`);

  const broadcastPath = join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json");
  if (!existsSync(broadcastPath)) fail(`deploy broadcast missing: ${broadcastPath}`);
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));

  const production = deploymentGasReport(broadcast, { exclude: NON_PRODUCTION });
  const everything = deploymentGasReport(broadcast);
  const infra = everything.contracts.filter(c => NON_PRODUCTION.includes(c.contractName));

  const width = Math.max(...everything.contracts.map(c => c.contractName.length));
  const line = row => `    ${row.contractName.padEnd(width)}  ${String(row.gasUsed).padStart(9)} gas`;

  console.log("\n==> Loom production contract deployment gas (from broadcast receipts)");
  for (const row of production.contracts) console.log(line(row));
  console.log(`    ${"TOTAL (production)".padEnd(width)}  ${String(production.totalGas).padStart(9)} gas`);

  if (infra.length > 0) {
    console.log("\n    Excluded (not part of a Loom production deployment):");
    for (const row of infra) console.log(line(row));
  }
}

try {
  await main();
} finally {
  if (anvil && !anvil.killed) anvil.kill();
}
