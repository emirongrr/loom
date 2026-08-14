import { resolve } from "node:path";
import { createWalletLabServer } from "./server.mjs";

const artifactPath = resolve(process.argv[2] ?? ".loom/wallet-lab/latest-run.json");
const server = createWalletLabServer({ artifactPath, port: Number(process.env.LOOM_WALLET_LAB_PORT ?? 4173) });
const listening = await server.start();
console.log(`Loom Wallet Lab: ${listening.url}`);
console.log(`Artifact: ${artifactPath}`);
await new Promise(resolveStop => {
  const stop = async () => {
    await server.stop();
    resolveStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
