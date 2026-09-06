import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletLabServer } from "./server.mjs";
import { createJsonRpc, rpcEndpointOrigin } from "./sepolia-deployment.mjs";

const args = process.argv.slice(2);
const valueFor = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const positional = args.find((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1].startsWith("--")));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifactPath = resolve(positional ?? ".loom/wallet-lab/latest-run.json");
const rpcUrl = valueFor("--rpc-url") ?? process.env.SEPOLIA_RPC_URL;
const manifestPath = resolve(valueFor("--sepolia-manifest") ?? fileURLToPath(new URL("../../examples/passkey-wallet-web/public/sepolia.deployment.json", import.meta.url)));
const sepoliaProfile = { repoRoot, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
const sepolia = rpcUrl ? {
  ...sepoliaProfile,
  rpc: createJsonRpc(rpcUrl),
  endpointOrigin: rpcEndpointOrigin(rpcUrl)
} : undefined;
const localExecution = { rpc: createJsonRpc("http://127.0.0.1:8545"), chainId: 31337, sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" };
const server = createWalletLabServer({ artifactPath, port: Number(process.env.LOOM_WALLET_LAB_PORT ?? 4173), localExecution, sepolia, sepoliaProfile });
const listening = await server.start();
console.log(`Loom Wallet Lab: ${listening.url}`);
console.log(`Artifact: ${artifactPath}`);
console.log(sepolia ? `Sepolia: verification enabled through ${sepolia.endpointOrigin}` : "Sepolia: connect a public RPC preset from the UI, set SEPOLIA_RPC_URL, or pass --rpc-url");
await new Promise(resolveStop => {
  const stop = async () => {
    await server.stop();
    resolveStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
