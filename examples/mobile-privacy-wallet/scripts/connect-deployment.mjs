// Connects a DeploySepolia broadcast to this example by using the reusable Loom
// wallet deployment toolkit.
//
//   node scripts/connect-deployment.mjs \
//     [--broadcast ../../broadcast/DeploySepolia.s.sol/11155111/run-latest.json] \
//     [--rpc $SEPOLIA_RPC_URL] [--entrypoint $SEPOLIA_ENTRYPOINT] \
//     [--p256-verifier $SEPOLIA_P256_FALLBACK_VERIFIER]
//
// The core toolkit reads the broadcast, verifies live chain code hashes, writes
// the app manifest and env values, then re-reads them and checks env ==
// manifest == chain. Any mismatch exits non-zero.

import path from "node:path";
import process from "node:process";
import {
  connectWalletAppDeployment,
  createJsonRpcClient,
  NATIVE_P256_PRECOMPILE
} from "../../../tools/deployment/wallet-app-deployment.mjs";
import { probeP256Precompile } from "./p256-probe.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(exampleRoot, "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const broadcastPath = path.resolve(
  exampleRoot,
  arg("broadcast", path.join(repoRoot, "broadcast", "DeploySepolia.s.sol", "11155111", "run-latest.json"))
);
const rpcUrl = arg("rpc", process.env.SEPOLIA_RPC_URL);
const entryPoint = arg("entrypoint", process.env.SEPOLIA_ENTRYPOINT);
const p256VerifierMode = arg("p256-mode", "native-precompile");
const p256Verifier = arg(
  "p256-verifier",
  p256VerifierMode === "native-precompile" ? NATIVE_P256_PRECOMPILE : process.env.SEPOLIA_P256_FALLBACK_VERIFIER
);

if (!rpcUrl) fail("Missing --rpc (or SEPOLIA_RPC_URL).");
if (!entryPoint) fail("Missing --entrypoint (or SEPOLIA_ENTRYPOINT).");
if (p256VerifierMode !== "native-precompile" && p256VerifierMode !== "fallback-contract") {
  fail("--p256-mode must be native-precompile or fallback-contract.");
}
if (!p256Verifier) fail("Missing --p256-verifier (or SEPOLIA_P256_FALLBACK_VERIFIER) for fallback-contract mode.");

console.log("Connecting deployment with Loom wallet deployment tooling...");
try {
  const result = await connectWalletAppDeployment({
    broadcastPath,
    manifestPath: path.join(exampleRoot, "deployment", "sepolia.manifest.json"),
    envPath: path.join(exampleRoot, ".env.local"),
    manifestReference: "deployment/sepolia.manifest.json",
    rpc: createJsonRpcClient(rpcUrl),
    entryPoint,
    p256VerifierMode,
    p256Verifier,
    probeP256: () => probeP256Precompile(rpcUrl)
  });

  console.log("Wrote deployment/sepolia.manifest.json");
  console.log("Updated .env.local");
  console.log("\nVerification checks:");
  for (const check of result.verification.checks) {
    console.log(`${check.ok ? "  ok " : " FAIL"} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  console.log("\nAll checks passed. Restart the dev server to load the new configuration.");
} catch (error) {
  fail(`${error.message}. Do NOT use this configuration.`);
}
