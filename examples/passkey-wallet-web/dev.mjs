// Bring up the whole local environment: the page and, when it is configured,
// the sponsor backend that pays for account creation.
//
// The sponsor is optional on purpose. It spends real funds, so it starts only
// when both its RPC endpoint and its key are present in the environment —
// nothing here selects a provider or a key on your behalf. Without them the
// page still runs and everything that does not touch the chain still works;
// the reason the sponsor is absent is printed rather than left to a failed
// fetch in the browser.
//
// Usage:
//   node examples/passkey-wallet-web/dev.mjs
//   SEPOLIA_RPC_URL=… SEPOLIA_SPONSOR_PRIVATE_KEY=… node examples/passkey-wallet-web/dev.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Load .env if present. Real environment variables win, so an explicit export
// can always override the file.
const envFile = join(here, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log(`[dev] loaded ${envFile}`);
} else {
  console.log("[dev] no .env (copy .env.example to .env to configure the sponsor)");
}

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const port = flag("port") ?? "5174";
const sponsorPort = flag("sponsor-port") ?? process.env.SPONSOR_PORT ?? "8787";
const rpcUrl = flag("rpc-url") ?? process.env.SEPOLIA_RPC_URL;
const key = process.env.SEPOLIA_SPONSOR_PRIVATE_KEY;

const children = [];

function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: here,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const prefix = line => line.length > 0 && console.log(`[${label}] ${line}`);
  child.stdout.on("data", data => String(data).split("\n").forEach(prefix));
  child.stderr.on("data", data => String(data).split("\n").forEach(prefix));
  child.on("exit", code => {
    console.log(`[${label}] exited with code ${code}`);
    // The page is the point of this script; if it dies, stop pretending.
    if (label === "web") shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("web", [join(here, "node_modules", "vite", "bin", "vite.js"), here, "--port", port]);

if (rpcUrl && key) {
  start("sponsor", [join(here, "sponsor-server.mjs"), "--rpc-url", rpcUrl, "--port", sponsorPort]);
} else {
  const missing = [!rpcUrl && "SEPOLIA_RPC_URL", !key && "SEPOLIA_SPONSOR_PRIVATE_KEY"].filter(Boolean);
  console.log(`[sponsor] not started — missing ${missing.join(" and ")}`);
  console.log("[sponsor] the page runs without it; account creation stays counterfactual.");
  console.log("[sponsor] set them and restart to sponsor on-chain deployment:");
  console.log('[sponsor]   $env:SEPOLIA_RPC_URL = "https://…"');
  console.log('[sponsor]   $env:SEPOLIA_SPONSOR_PRIVATE_KEY = "0x…"');
}
