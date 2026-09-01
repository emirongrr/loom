// Connect a DeploySepolia broadcast to this example, through the shared Loom
// wallet deployment toolkit.
//
//   node scripts/connect-deployment.mjs \
//     [--broadcast ../../broadcast/DeploySepolia.s.sol/11155111/run-latest.json] \
//     [--rpc $SEPOLIA_RPC_URL] \
//     [--verification-rpc $SEPOLIA_VERIFICATION_RPC_URL] \
//     [--entrypoint $SEPOLIA_ENTRYPOINT] \
//     [--onboarding counterfactual|sponsored] \
//     [--sponsor-authorizer $SEPOLIA_SPONSOR_AUTHORIZER]
//
// `public/sepolia.deployment.json` is the only thing this wallet trusts: it
// names the contracts and pins their runtime code hashes, and the app refuses
// to sign anything when the chain disagrees with it. Writing it by hand is how
// it drifts from the deployment it claims to describe -- and a drifted profile
// does not fail loudly, it just makes the wallet refuse to work. Nothing here
// is copied by a person: addresses come from the broadcast, hashes from the
// chain.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildWalletProfileManifest, createJsonRpcClient, recoveryValidatorRuntimeCodeHash } from "@loom/deployment";
import { parseFoundryBroadcast } from "@loom/deployment";

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

function artifact(relative, label) {
  const file = path.join(repoRoot, "out", relative);
  if (!existsSync(file)) throw new Error(`${label} artifact is missing; run forge build first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  const broadcastPath = arg(
    "broadcast",
    path.join(repoRoot, "broadcast", "DeploySepolia.s.sol", "11155111", "run-latest.json")
  );
  const rpcUrl = arg("rpc", process.env.SEPOLIA_RPC_URL ?? envFromFile("SEPOLIA_RPC_URL"));
  const verificationRpcUrl = arg(
    "verification-rpc",
    process.env.SEPOLIA_VERIFICATION_RPC_URL ?? envFromFile("SEPOLIA_VERIFICATION_RPC_URL")
  );
  const entryPoint = arg("entrypoint", process.env.SEPOLIA_ENTRYPOINT ?? envFromFile("SEPOLIA_ENTRYPOINT"));
  const activation = arg("onboarding", process.env.LOOM_ONBOARDING_ACTIVATION ?? "counterfactual");
  if (!rpcUrl) throw new Error("no RPC endpoint: pass --rpc or set SEPOLIA_RPC_URL");
  if (!verificationRpcUrl) {
    throw new Error("no independent verification RPC: pass --verification-rpc or set SEPOLIA_VERIFICATION_RPC_URL");
  }
  if (rpcUrl === verificationRpcUrl) throw new Error("deployment RPCs must be independent endpoints");
  if (!entryPoint) throw new Error("no EntryPoint: pass --entrypoint or set SEPOLIA_ENTRYPOINT");
  const onboarding = activation === "counterfactual"
    ? { activation }
    : activation === "sponsored"
      ? {
          activation,
          sponsorship: {
            policyId: arg("sponsor-policy-id", process.env.SPONSOR_POLICY_ID ?? "loom-sepolia-onboarding-v1"),
            authorizer: arg("sponsor-authorizer", process.env.SEPOLIA_SPONSOR_AUTHORIZER),
            maxCostWei: arg("sponsor-max-cost-wei", process.env.SPONSOR_MAX_COST_WEI ?? "5000000000000000"),
            maxFactoryDataBytes: numberArg("sponsor-max-factory-data-bytes", process.env.SPONSOR_MAX_FACTORY_DATA_BYTES ?? "8192"),
            maxActivationsPerPrincipal: numberArg("sponsor-max-activations-per-principal", process.env.SPONSOR_MAX_ACTIVATIONS_PER_PRINCIPAL ?? "3"),
            windowSeconds: numberArg("sponsor-window-seconds", process.env.SPONSOR_WINDOW_SECONDS ?? "86400"),
            privateSubmission: true,
            publicFallback: arg("sponsor-public-fallback", process.env.SPONSOR_PUBLIC_FALLBACK ?? "disabled")
          }
        }
      : (() => { throw new Error("--onboarding must be counterfactual or sponsored"); })();

  const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
  const rpc = createJsonRpcClient(rpcUrl);
  const verificationRpc = createJsonRpcClient(verificationRpcUrl);
  const chainIds = await Promise.all([rpc("eth_chainId", []), verificationRpc("eth_chainId", [])]);
  if (chainIds.some(chainId => BigInt(chainId) !== 11_155_111n)) {
    throw new Error(`both deployment RPCs must report Sepolia chain 11155111; received ${chainIds.join(", ")}`);
  }

  // The child's immutables are its factory and the fallback verifier, so both
  // have to be known before its runtime hash can be computed. The factory comes
  // from the same broadcast the profile is built from; the verifier is read
  // from the factory itself, which is where the child gets it too.
  const created = parseFoundryBroadcast(broadcast).createdContracts;
  const recoveryFactory = created.P256RecoveryValidatorFactory;
  if (!recoveryFactory) throw new Error("this broadcast has no P256RecoveryValidatorFactory");

  const proxyCreationCode = artifactField(
    "LoomAccountProxy.sol/LoomAccountProxy.json",
    json => json?.bytecode?.object,
    "LoomAccountProxy"
  );
  const recoveryArtifact = artifact("P256RecoveryValidator.sol/P256RecoveryValidator.json", "P256RecoveryValidator");
  const p256Artifact = artifact("P256Validator.sol/P256Validator.json", "P256Validator");
  const profileFrom = async client => buildWalletProfileManifest({
    broadcast,
    rpc: client,
    entryPoint,
    proxyCreationCode,
    onboarding,
    // No recovery validator child exists on a fresh deployment, so its runtime
    // hash is computed from the build -- with the immutables filled in.
    //
    // Hashing the artifact's `deployedBytecode` directly was wrong and shipped:
    // the child declares immutables, Solidity leaves them zeroed in the
    // artifact and writes them at construction, so the artifact's hash can
    // never equal a deployed child's. A profile pinned to it makes every
    // recovery on that deployment fail closed with "deployed recovery validator
    // code does not match the trusted deployment profile" -- a manifest error
    // reported as a lost passkey.
    validatorRuntimeCodeHash: recoveryValidatorRuntimeCodeHash({
      artifact: recoveryArtifact,
      baseArtifacts: [p256Artifact],
      values: {
        recoveryValidatorFactory: recoveryFactory,
        fallbackVerifier: await readFallbackVerifier(client, recoveryFactory)
      }
    })
  });
  const [profile, independentlyObservedProfile] = await Promise.all([
    profileFrom(rpc),
    profileFrom(verificationRpc)
  ]);
  if (JSON.stringify(profile) !== JSON.stringify(independentlyObservedProfile)) {
    throw new Error("independent RPCs disagree about the deployment; no wallet manifest was written");
  }

  const out = path.join(exampleRoot, "public", "sepolia.deployment.json");
  const pending = `${out}.pending-${process.pid}`;
  try {
    await writeFile(pending, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(pending, out);
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
  const pinned = Object.keys(profile.runtimeCodeHashes).length;
  console.log(`wrote ${path.relative(repoRoot, out)}: chain ${profile.chainId}, ${pinned} pinned code hash(es)`);
  if (!profile.recoveryIntentBoard) {
    console.warn("note: this broadcast has no RecoveryIntentBoard, so on-chain guardian discovery will be inert");
  }
}

function numberArg(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

async function readFallbackVerifier(rpc, factory) {
  const selector = "0xfe3c90b0"; // fallbackVerifier()
  const result = await rpc("eth_call", [{ to: factory, data: selector }, "latest"]);
  if (typeof result !== "string" || result.length !== 66) {
    throw new Error("the recovery validator factory did not return a fallback verifier");
  }
  return `0x${result.slice(26)}`;
}

await main();
