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
// Key handling: the executor key and the RPC URL (which often embeds a
// provider token) are passed to Alto through child-process environment
// variables (ALTO_*), never through argv, so neither appears in local process
// listings. Still prefer a low-balance Sepolia rehearsal key over a production
// deployer or user key. The Alto version is pinned to the same release the
// Loom devnet pins in devnet/versions.json.
//
// Self-hosting is the sovereignty path; hosted bundlers (Pimlico, Alchemy,
// Biconomy…) are the managed path. The app treats both as replaceable
// transports — production wallets should qualify at least two independent
// bundlers (GAPS.md G-003).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const envPath = process.argv[2] ?? path.resolve(import.meta.dirname, "..", ".env.sepolia.local");
const altoVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "devnet", "versions.json"), "utf8")).alto;

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
console.log(`Starting Alto ${altoVersion} on http://localhost:${port} (EntryPoint ${entryPoint})…`);
console.log("Safe mode is disabled: public RPCs rarely expose debug_traceCall. Dev use only.");
console.log("Executor key and RPC URL are passed via environment, not argv.\n");

// Alto reads any option from an ALTO_-prefixed environment variable; the
// sensitive values (signing key, provider URL with its token) go that way so
// argv stays free of secrets. npx resolves the pinned version on first run.
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--yes",
    `@pimlico/alto@${altoVersion}`,
    "run",
    "--entrypoints",
    entryPoint,
    "--safe-mode",
    "false",
    "--port",
    port
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ALTO_RPC_URL: rpcUrl,
      ALTO_EXECUTOR_PRIVATE_KEYS: executorKey,
      ALTO_UTILITY_PRIVATE_KEY: executorKey
    }
  }
);
child.on("exit", code => process.exit(code ?? 0));
