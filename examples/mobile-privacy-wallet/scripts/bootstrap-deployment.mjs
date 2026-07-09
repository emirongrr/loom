// First-deployment bootstrap: one command from an empty env to a connected app.
//
//   npm run bootstrap
//
// Pipeline:
//   1. Check the Sepolia env file — if required fields are empty, print
//      exactly which ones and stop.
//   2. Probe the native EIP-7951 P-256 precompile (default mode). The probe
//      signs a fresh P-256 vector and verifies it via eth_call; native mode
//      is only used when the probe passes on the live chain.
//   3. Run script/DeploySepolia.s.sol with forge --broadcast.
//   4. Run scripts/connect-deployment.mjs: write manifest + .env.local and
//      verify env == manifest == chain.
//   5. Print the remaining manual steps (bundler, dev server restart).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { probeP256Precompile, P256_PRECOMPILE } from "./p256-probe.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(exampleRoot, "..", "..");
const envPath = path.join(exampleRoot, ".env.sepolia.local");

function fail(message) {
  console.error(`\nFAIL ${message}`);
  process.exit(1);
}

// --- 1. Env check -------------------------------------------------------------

if (!fs.existsSync(envPath)) {
  fail(`Missing ${envPath}. Create it from the template and fill it in.`);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter(line => line.includes("=") && !line.trim().startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
);

const missing = ["SEPOLIA_RPC_URL", "SEPOLIA_DEPLOYER_PRIVATE_KEY", "SEPOLIA_ENTRYPOINT"].filter(
  key => !env[key]
);
if (missing.length > 0) {
  console.error("\nThese required fields are empty — fill them in before bootstrapping:\n");
  for (const key of missing) {
    console.error(`  ${key}=            <- ${envPath}`);
  }
  console.error("\nThen run `npm run bootstrap` again.");
  process.exit(1);
}

// --- 2. Native P-256 precompile probe ------------------------------------------

// Native precompile is the default: Sepolia and mainnet expose EIP-7951 at
// 0x100. The deploy script selects native mode for Sepolia on its own; this
// probe confirms the live chain actually verifies signatures before any
// contract is deployed against that assumption.
console.log("Probing the native P-256 precompile (EIP-7951, 0x100) on the target chain…");
const probe = await probeP256Precompile(env.SEPOLIA_RPC_URL);
if (!probe.supported) {
  fail(
    `The P-256 precompile at ${P256_PRECOMPILE} did not verify a fresh test vector ` +
      `(valid -> ${probe.valid}, corrupted -> ${probe.invalid}). ` +
      "Do not deploy: the deploy script would select native mode for this chain. " +
      "Investigate the RPC or the chain fork before retrying."
  );
}
console.log("Native P-256 precompile verified: valid signature -> 1, corrupted signature -> empty.\n");

// --- 3. Deploy ----------------------------------------------------------------

const forge = path.join(repoRoot, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forgeBin = fs.existsSync(forge) ? forge : "forge";
console.log("\nDeploying Loom to Sepolia (forge script script/DeploySepolia.s.sol --broadcast)…\n");
const deploy = spawnSync(
  forgeBin,
  ["script", "script/DeploySepolia.s.sol:DeploySepolia", "--rpc-url", env.SEPOLIA_RPC_URL, "--broadcast"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SEPOLIA_DEPLOYER_PRIVATE_KEY: env.SEPOLIA_DEPLOYER_PRIVATE_KEY,
      SEPOLIA_ENTRYPOINT: env.SEPOLIA_ENTRYPOINT
    }
  }
);
if (deploy.status !== 0) {
  fail("forge deployment failed — nothing was connected. Fix the error above and re-run `npm run bootstrap`.");
}

// --- 4. Connect + verify --------------------------------------------------------

console.log("\nConnecting the deployment to the app (manifest + .env.local + on-chain verification)…\n");
const connect = spawnSync(
  process.execPath,
  [
    path.join(exampleRoot, "scripts", "connect-deployment.mjs"),
    "--rpc",
    env.SEPOLIA_RPC_URL,
    "--entrypoint",
    env.SEPOLIA_ENTRYPOINT,
    "--p256-mode",
    "native-precompile",
    "--p256-verifier",
    P256_PRECOMPILE
  ],
  { cwd: exampleRoot, stdio: "inherit" }
);
if (connect.status !== 0) {
  fail("connect-deployment verification failed. Do not use this configuration.");
}

// --- 5. Next steps --------------------------------------------------------------

console.log(`
Bootstrap complete. Remaining steps:

  1. Start a bundler:  npm run bundler:local   (or set a hosted bundler URL)
  2. Put its URL into EXPO_PUBLIC_LOOM_BUNDLER_URL (or the in-app Settings screen)
  3. Restart the dev server:  npm run start
`);
