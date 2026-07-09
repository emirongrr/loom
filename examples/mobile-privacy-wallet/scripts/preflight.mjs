// Start preflight: the dev server only starts against a connected deployment.
//
// Runs automatically before `npm run start` / `npm run android` / `npm run ios`
// (npm pre-hooks). If the app is not connected to a Loom deployment it prints
// exactly which fields are empty and how to fill them, then exits non-zero.
//
// Escape hatch for UI-only work without a deployment:
//   LOOM_ALLOW_UNCONFIGURED=1 npm run start

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(exampleRoot, ".env.local");
const manifestPath = path.join(exampleRoot, "deployment", "sepolia.manifest.json");

if (process.env.LOOM_ALLOW_UNCONFIGURED === "1") {
  console.log("preflight: LOOM_ALLOW_UNCONFIGURED=1 — starting without a connected deployment (UI-only mode).");
  process.exit(0);
}

const problems = [];

if (!fs.existsSync(envPath)) {
  problems.push(".env.local does not exist — copy .env.example to .env.local.");
}
const env = fs.existsSync(envPath)
  ? Object.fromEntries(
      fs
        .readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter(line => line.includes("=") && !line.trim().startsWith("#"))
        .map(line => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
    )
  : {};

const DEPLOYMENT_KEYS = [
  "EXPO_PUBLIC_LOOM_CHAIN_ID",
  "EXPO_PUBLIC_LOOM_L1_CHAIN_ID",
  "EXPO_PUBLIC_LOOM_ENTRYPOINT",
  "EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY",
  "EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR",
  "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE",
  "EXPO_PUBLIC_LOOM_P256_VERIFIER"
];
const USER_KEYS = ["EXPO_PUBLIC_LOOM_RP_ID", "EXPO_PUBLIC_LOOM_ORIGIN"];

const emptyDeployment = DEPLOYMENT_KEYS.filter(key => !env[key]);
const emptyUser = USER_KEYS.filter(key => !env[key]);

let manifestConnected = false;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifestConnected = Number.isInteger(manifest.chainId) && manifest.chainId > 0;
} catch {
  manifestConnected = false;
}

if (emptyDeployment.length > 0 || !manifestConnected) {
  console.error("\npreflight: the app is NOT connected to a Loom deployment.\n");
  if (emptyDeployment.length > 0) {
    console.error("Empty deployment fields in .env.local:\n");
    for (const key of emptyDeployment) {
      console.error(`  ${key}=`);
    }
    console.error("");
  }
  if (!manifestConnected) {
    console.error("deployment/sepolia.manifest.json is still the placeholder (no verified deployment).\n");
  }
  console.error("First deployment (fills everything above automatically):\n");
  console.error("  1. Fill SEPOLIA_RPC_URL and SEPOLIA_DEPLOYER_PRIVATE_KEY in .env.sepolia.local (this directory)");
  console.error("  2. npm run bootstrap\n");
  console.error("UI-only start without a deployment: LOOM_ALLOW_UNCONFIGURED=1 npm run start\n");
  process.exit(1);
}

if (emptyUser.length > 0) {
  console.warn("\npreflight: deployment connected, but these passkey-binding fields are still empty:\n");
  for (const key of emptyUser) {
    console.warn(`  ${key}=`);
  }
  console.warn("\nAccount creation stays blocked until they are set (they must match the native RP policy).\n");
}

problems.forEach(problem => console.error(`preflight: ${problem}`));
if (problems.length > 0) {
  process.exit(1);
}
console.log("preflight: connected to a Loom deployment — starting.");
