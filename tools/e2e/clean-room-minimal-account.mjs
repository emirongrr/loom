// Clean-room proof for the minimal-account example.
//
//   npm run e2e:clean-room
//
// Packs @loom/core and @loom/sdk through the SAME release packer that produces
// the published tarballs, installs those exact tarballs into an EMPTY temporary
// project together with the example script, statically asserts the consumer
// imports only public package names, then runs it against a fresh devnet (anvil
// + DeployDevnet). If the example completes, an external developer can derive,
// deploy, and operate a Loom account from published packages alone — and the
// artifact that ships is the artifact that is proven here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, parseFoundryBroadcast } from "../../packages/deployment/src/index.js";
import { packReleasePackages } from "../release/pack-packages.mjs";

// A fixed non-release version for the clean-room proof, distinct from any tag.
const CLEAN_ROOM_VERSION = "0.0.0-cleanroom";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = "http://127.0.0.1:8545";
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const stageRoot = join(repoRoot, ".tmp", "clean-room");

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}

function fail(message) {
  console.error(`\nFAIL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(name, command, args, options = {}) {
  console.log(`==> ${name}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32" && String(command).endsWith(".cmd"),
    env: { ...process.env, ...(options.env ?? {}) }
  });
  if (result.status !== 0) fail(`${name} exited with ${result.status}`);
}

async function waitForRpc(rpc, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  fail("anvil did not become reachable");
}

function packPackages() {
  // The release packer is the single packing path: it wipes the output dir,
  // stages each package with a release version, rewrites the sdk's file:../core
  // dependency to that exact version, and strips private/dev fields. Using it
  // here means the clean-room proof installs byte-for-byte the artifact a
  // release would publish. It clears stageRoot, so create the app dir after.
  console.log("==> Pack @loom/core and @loom/sdk (release packer)");
  const manifest = packReleasePackages({ repoRoot, version: CLEAN_ROOM_VERSION, outDir: stageRoot });
  mkdirSync(join(stageRoot, "app"), { recursive: true });
  const byName = Object.fromEntries(manifest.packages.map(p => [p.name, join(stageRoot, p.filename)]));
  return { core: byName["@loom/core"], sdk: byName["@loom/sdk"] };
}

function assertCleanRoom(consumerSource) {
  for (const forbidden of ["packages/", "../", "..\\"]) {
    if (consumerSource.includes(`from "${forbidden}`) || consumerSource.includes(`from '${forbidden}`)) {
      fail(`consumer imports a repository path (${forbidden})`);
    }
  }
  console.log("    ok  consumer imports only public package names");
}

let anvil;

async function main() {
  const consumerSource = readFileSync(join(repoRoot, "examples", "minimal-account", "index.mjs"), "utf8");
  assertCleanRoom(consumerSource);

  run("Build the packages", npm, ["run", "sdk:build"]);
  const tarballs = packPackages();
  for (const tarball of Object.values(tarballs)) {
    if (!existsSync(tarball)) fail(`missing tarball: ${tarball}`);
  }

  const app = join(stageRoot, "app");
  writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "minimal-account-app", private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(app, "index.mjs"), consumerSource);
  run("Install packed packages into the empty app", npm, ["install", tarballs.core, tarballs.sdk, "viem@2.55.1"], {
    cwd: app
  });

  const rpc = createJsonRpcClient(RPC_URL);
  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", "31337", "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  await waitForRpc(rpc);

  run("Deploy the Loom stack", bin("forge"), [
    "script",
    "script/DeployDevnet.s.sol:DeployDevnet",
    "--rpc-url",
    RPC_URL,
    "--broadcast",
    "--skip-simulation"
  ], { env: { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY } });

  const broadcast = JSON.parse(
    readFileSync(join(repoRoot, "broadcast", "DeployDevnet.s.sol", "31337", "run-latest.json"), "utf8")
  );
  const created = parseFoundryBroadcast(broadcast).createdContracts;
  const need = name => created[name] ?? fail(`deployment is missing ${name}`);

  const implementationWord = await rpc("eth_call", [
    { to: need("LoomAccountFactory"), data: "0x11464fbe" }, // accountImplementation()
    "latest"
  ]);
  const proxyArtifact = JSON.parse(
    readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8")
  );

  run("Run the clean-room consumer", process.execPath, ["index.mjs"], {
    cwd: app,
    env: {
      LOOM_RPC_URL: RPC_URL,
      LOOM_ENTRYPOINT: need("EntryPoint"),
      LOOM_FACTORY: need("LoomAccountFactory"),
      LOOM_P256_VALIDATOR: need("P256Validator"),
      LOOM_POLICY_HOOK: need("PolicyHook"),
      LOOM_TARGET: need("DevnetTarget"),
      LOOM_IMPLEMENTATION: `0x${implementationWord.slice(26)}`,
      LOOM_PROXY_CREATION_CODE: proxyArtifact.bytecode.object,
      LOOM_DEPLOYER: DEPLOYER_ADDRESS
    }
  });

  console.log("\nClean-room minimal-account passed: packed install, public imports only, live devnet lifecycle.");
}

try {
  await main();
} finally {
  if (anvil && !anvil.killed) anvil.kill();
}
