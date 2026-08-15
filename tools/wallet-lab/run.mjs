import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletLabServer } from "./server.mjs";
import { createJsonRpc, rpcEndpointOrigin } from "./sepolia-deployment.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifactPath = join(repoRoot, ".loom", "wallet-lab", "latest-run.json");
const port = Number(process.env.LOOM_WALLET_LAB_PORT ?? 4173);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
const runId = `run-${crypto.randomBytes(8).toString("hex")}`;
const traceId = crypto.createHash("sha256").update(`${runId}:passkey-native-transfer.v1`).digest("hex").slice(0, 32);
const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL;
const sepoliaProfile = {
  repoRoot,
  manifest: JSON.parse(readFileSync(join(repoRoot, "examples", "passkey-wallet-web", "public", "sepolia.deployment.json"), "utf8"))
};
const sepolia = sepoliaRpcUrl ? {
  ...sepoliaProfile,
  rpc: createJsonRpc(sepoliaRpcUrl),
  endpointOrigin: rpcEndpointOrigin(sepoliaRpcUrl)
} : undefined;
const server = createWalletLabServer({ artifactPath, port, sepolia, sepoliaProfile });
const listening = await server.start();

process.env.LOOM_WALLET_LAB_ARTIFACT = artifactPath;
process.env.LOOM_WALLET_LAB_RUN_ID = runId;
process.env.LOOM_WALLET_LAB_TRACE_ID = traceId;
process.env.LOOM_WALLET_LAB_GIT_COMMIT = commit;
process.env.LOOM_WALLET_LAB_GIT_DIRTY = String(dirty);
process.env.LOOM_WALLET_LAB_BROWSER_FLOW = "true";

console.log(`Loom Wallet Lab: ${listening.url}`);
console.log(`Run artifact: ${artifactPath}`);
console.log("The UI is live while the deterministic devnet scenario runs.");

let exitCode = 0;
try {
  await import("../../tools/e2e/bundler-devnet.mjs");
} catch (error) {
  exitCode = 1;
  console.error(error);
}

console.log(exitCode === 0 ? "Wallet Lab scenario completed. Press Ctrl+C to stop the UI." : "Wallet Lab scenario failed. The UI remains available for diagnosis; press Ctrl+C to stop.");
process.exitCode = exitCode;
await new Promise(resolve => {
  const stop = async () => {
    await server.stop();
    resolve();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
