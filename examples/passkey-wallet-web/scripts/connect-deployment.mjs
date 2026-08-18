// Connect a DeploySepolia broadcast to this example, through the shared Loom
// wallet deployment toolkit.
//
//   node scripts/connect-deployment.mjs \
//     [--broadcast ../../broadcast/DeploySepolia.s.sol/11155111/run-latest.json] \
//     [--rpc $SEPOLIA_RPC_URL] [--entrypoint $SEPOLIA_ENTRYPOINT]
//
// `public/sepolia.deployment.json` is the only thing this wallet trusts: it
// names the contracts and pins their runtime code hashes, and the app refuses
// to sign anything when the chain disagrees with it. Writing it by hand is how
// it drifts from the deployment it claims to describe -- and a drifted profile
// does not fail loudly, it just makes the wallet refuse to work. Nothing here
// is copied by a person: addresses come from the broadcast, hashes from the
// chain.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildWalletProfileManifest, createJsonRpcClient } from "@loom/deployment";
import { keccak256 } from "viem";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(exampleRoot, "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function envFromFile(name) {
  const file = path.join(exampleRoot, ".env");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find(entry => entry.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

function artifactField(relative, pick, label) {
  const artifact = path.join(repoRoot, "out", relative);
  if (!existsSync(artifact)) throw new Error(`${label} artifact is missing; run forge build first`);
  const value = pick(JSON.parse(readFileSync(artifact, "utf8")));
  if (typeof value !== "string" || !value.startsWith("0x")) throw new Error(`${label} artifact has no bytecode`);
  return value;
}

async function main() {
  const broadcastPath = arg(
    "broadcast",
    path.join(repoRoot, "broadcast", "DeploySepolia.s.sol", "11155111", "run-latest.json")
  );
  const rpcUrl = arg("rpc", process.env.SEPOLIA_RPC_URL ?? envFromFile("SEPOLIA_RPC_URL"));
  const entryPoint = arg("entrypoint", process.env.SEPOLIA_ENTRYPOINT ?? envFromFile("SEPOLIA_ENTRYPOINT"));
  if (!rpcUrl) throw new Error("no RPC endpoint: pass --rpc or set SEPOLIA_RPC_URL");
  if (!entryPoint) throw new Error("no EntryPoint: pass --entrypoint or set SEPOLIA_ENTRYPOINT");

  const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
  const profile = await buildWalletProfileManifest({
    broadcast,
    rpc: createJsonRpcClient(rpcUrl),
    entryPoint,
    proxyCreationCode: artifactField(
      "LoomAccountProxy.sol/LoomAccountProxy.json",
      json => json?.bytecode?.object,
      "LoomAccountProxy"
    ),
    // No recovery validator child exists on a fresh deployment, so its runtime
    // hash comes from the build. That is checkable rather than assumed: the
    // deployed factory's `validatorInitCodeHash` derives from the same creation
    // code, so a mismatch there would mean the factory produces something other
    // than what this pins.
    validatorRuntimeCodeHash: keccak256(artifactField(
      "P256RecoveryValidator.sol/P256RecoveryValidator.json",
      json => json?.deployedBytecode?.object,
      "P256RecoveryValidator"
    ))
  });

  const out = path.join(exampleRoot, "public", "sepolia.deployment.json");
  await writeFile(out, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  const pinned = Object.keys(profile.runtimeCodeHashes).length;
  console.log(`wrote ${path.relative(repoRoot, out)}: chain ${profile.chainId}, ${pinned} pinned code hash(es)`);
  if (!profile.recoveryIntentBoard) {
    console.warn("note: this broadcast has no RecoveryIntentBoard, so on-chain guardian discovery will be inert");
  }
}

await main();
