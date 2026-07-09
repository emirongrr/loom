// Runs a self-hosted ERC-4337 bundler (Pimlico's open-source Alto) against
// Sepolia, using the same env file as the deployment:
//
//   node scripts/run-local-bundler.mjs            # reads ./.env.sepolia.local
//
// The bundler listens on http://localhost:4337 — enter that URL in the app's
// Settings screen (or EXPO_PUBLIC_LOOM_BUNDLER_URL). The executor key must
// hold Sepolia ETH: the bundler fronts the gas for every UserOperation and is
// refunded by the EntryPoint.
//
// Key-handling note: Alto currently receives executor keys through CLI flags.
// That means the rehearsal key can be visible to local process-inspection
// tools while the bundler is running. Use a Sepolia-only hot key with minimal
// funds, never a production deployer or user key.
//
// Self-hosting is the sovereignty path; hosted bundlers (Pimlico, Alchemy,
// Biconomy…) are the managed path. The app treats both as replaceable
// transports — production wallets should qualify at least two independent
// bundlers (GAPS.md G-003).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const envPath = process.argv[2] ?? path.resolve(import.meta.dirname, "..", ".env.sepolia.local");

if (!fs.existsSync(envPath)) {
  console.error(`Missing ${envPath}. Fill the Sepolia env file first.`);
  process.exit(1);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter(line => line.includes("=") && !line.trim().startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
);

const rpcUrl = env.SEPOLIA_RPC_URL;
const executorKey = env.SEPOLIA_DEPLOYER_PRIVATE_KEY;
const entryPoint = env.SEPOLIA_ENTRYPOINT;
for (const [name, value] of [
  ["SEPOLIA_RPC_URL", rpcUrl],
  ["SEPOLIA_DEPLOYER_PRIVATE_KEY", executorKey],
  ["SEPOLIA_ENTRYPOINT", entryPoint]
]) {
  if (!value) {
    console.error(`${name} is empty in ${envPath}.`);
    process.exit(1);
  }
}

const port = process.env.BUNDLER_PORT ?? "4337";
console.log(`Starting Alto bundler on http://localhost:${port} (EntryPoint ${entryPoint})…`);
console.log("Safe mode is disabled: public RPCs rarely expose debug_traceCall. Dev use only.\n");
console.warn(
  "Executor key argv exposure: use only a low-balance Sepolia rehearsal key; " +
    "never reuse a production deployer or user key.\n"
);

// npx resolves @pimlico/alto on first run; the executor key never leaves this
// machine, but Alto's current CLI receives it in argv on that machine.
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--yes",
    "@pimlico/alto",
    "run",
    "--entrypoints",
    entryPoint,
    "--rpc-url",
    rpcUrl,
    "--executor-private-keys",
    executorKey,
    "--utility-private-key",
    executorKey,
    "--safe-mode",
    "false",
    "--port",
    port
  ],
  { stdio: "inherit", shell: process.platform === "win32" }
);
child.on("exit", code => process.exit(code ?? 0));
