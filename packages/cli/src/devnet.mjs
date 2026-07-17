// Pinned local devnet lifecycle for the `loom` CLI.
//
// `up` composes the exact stack devnet/versions.json pins — anvil (Foundry),
// the repo-pinned EntryPoint v0.9 + Loom contracts (DeployDevnet), and the
// Alto bundler — then health-checks both endpoints and records ownership in
// .loom/devnet/state.json. `down`, `status`, and `logs` operate ONLY on the
// resources that state file records; the CLI never guesses at or kills
// processes it did not start.
//
// Key handling: the bundler executor/utility keys are anvil's well-known
// deterministic dev accounts (public constants, devnet only). The CLI never
// accepts a private key as input.

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const stateDir = join(repoRoot, ".loom", "devnet");
const statePath = join(stateDir, "state.json");
const versions = JSON.parse(readFileSync(join(repoRoot, "devnet", "versions.json"), "utf8"));

// anvil's deterministic dev keys (public constants — devnet only).
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
];

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function waitFor(label, probe, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await probe();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw Object.assign(new Error(`${label} did not become healthy`), { exitCode: 5 });
}

function readState() {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function spawnLogged(name, command, args, logName) {
  const log = openSync(join(stateDir, `${logName}.log`), "a");
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
    shell: process.platform === "win32" && String(command).endsWith(".cmd")
  });
  child.unref();
  if (!child.pid) throw Object.assign(new Error(`${name} failed to start`), { exitCode: 5 });
  return child.pid;
}

export async function up() {
  if (readState()) {
    throw Object.assign(new Error("devnet already running (state file exists); run `loom devnet down` first"), {
      exitCode: 2
    });
  }
  mkdirSync(stateDir, { recursive: true });
  const rpcUrl = `http://127.0.0.1:${versions.ports.rpc}`;
  const bundlerUrl = `http://127.0.0.1:${versions.ports.bundler}`;

  const anvilPid = spawnLogged(
    "anvil",
    bin("anvil"),
    ["--port", String(versions.ports.rpc), "--chain-id", String(versions.chainId)],
    "anvil"
  );
  await waitFor("anvil", () => rpc(rpcUrl, "eth_chainId", []));

  // Pre-deploy the EntryPoint at its pinned version-prefixed CREATE2 address
  // (bundlers detect the EntryPoint version from the address prefix). The
  // pinned salt is only valid for the pinned creation code.
  const entryPointArtifact = JSON.parse(readFileSync(join(repoRoot, "out", "EntryPoint.sol", "EntryPoint.json"), "utf8"));
  const creationCode = entryPointArtifact.bytecode.object;
  const { keccak_256 } = (await import("js-sha3")).default;
  const creationCodeHash = `0x${keccak_256(Buffer.from(creationCode.slice(2), "hex"))}`;
  if (creationCodeHash !== versions.entryPoint.creationCodeHash) {
    stopPid(anvilPid);
    throw Object.assign(
      new Error(
        "EntryPoint creation code changed; re-mine the CREATE2 salt for the 0x433709 prefix and update devnet/versions.json"
      ),
      { exitCode: 6 }
    );
  }
  const deployerAccount = versions.devAccounts.deployer;
  await rpc(rpcUrl, "eth_sendTransaction", [
    {
      from: deployerAccount,
      to: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
      gas: "0x7a1200",
      data: `${versions.entryPoint.salt}${creationCode.slice(2)}`
    }
  ]);
  const entryPointCode = await waitFor("EntryPoint CREATE2 deployment", async () => {
    const code = await rpc(rpcUrl, "eth_getCode", [versions.entryPoint.address, "latest"]);
    if (code === "0x") throw new Error("no code yet");
    return code;
  }, 20);
  if (entryPointCode === "0x") {
    stopPid(anvilPid);
    throw Object.assign(new Error("EntryPoint did not deploy at the pinned address"), { exitCode: 6 });
  }

  const deploy = spawnSync(
    bin("forge"),
    ["script", "script/DeployDevnet.s.sol:DeployDevnet", "--rpc-url", rpcUrl, "--broadcast", "--skip-simulation"],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        DEVNET_DEPLOYER_PRIVATE_KEY: ANVIL_KEYS[0],
        DEVNET_ENTRYPOINT: versions.entryPoint.address
      }
    }
  );
  writeFileSync(join(stateDir, "deploy.log"), `${deploy.stdout}\n${deploy.stderr}`);
  if (deploy.status !== 0) {
    stopPid(anvilPid);
    throw Object.assign(new Error("DeployDevnet failed; see .loom/devnet/deploy.log"), { exitCode: 6 });
  }

  const broadcast = JSON.parse(
    readFileSync(join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(versions.chainId), "run-latest.json"), "utf8")
  );
  const addresses = {};
  for (const tx of broadcast.transactions ?? []) {
    if (tx?.transactionType === "CREATE" && tx.contractName) addresses[tx.contractName] = tx.contractAddress;
    for (const extra of tx?.additionalContracts ?? []) {
      if (extra.contractName) addresses[extra.contractName] = extra.address;
    }
  }
  // The EntryPoint is CREATE2-pre-deployed, so it never appears in the
  // forge broadcast; record the pinned address alongside the deployed stack.
  addresses.EntryPoint = versions.entryPoint.address;
  const entryPoint = addresses.EntryPoint;

  // Alto is a pinned dependency of this package; run its entry script with the
  // current node directly (no npx, no shell) so the spawn is identical on
  // every platform and needs no network at runtime.
  const altoEntry = join(repoRoot, "packages", "cli", "node_modules", "@pimlico", "alto", "esm", "cli", "alto.js");
  if (!existsSync(altoEntry)) {
    stopPid(anvilPid);
    throw Object.assign(new Error("alto is not installed; run `npm --prefix packages/cli ci` first"), { exitCode: 2 });
  }
  const altoPid = spawnLogged(
    "alto",
    process.execPath,
    [
      altoEntry,
      "run",
      "--entrypoints",
      entryPoint,
      "--rpc-url",
      rpcUrl,
      "--executor-private-keys",
      ANVIL_KEYS[versions.devAccounts.bundlerExecutorIndex],
      "--utility-private-key",
      ANVIL_KEYS[versions.devAccounts.bundlerUtilityIndex],
      "--safe-mode",
      "false",
      "--port",
      String(versions.ports.bundler)
    ],
    "alto"
  );
  let supported;
  try {
    supported = await waitFor("alto", async () => {
      const result = await rpc(bundlerUrl, "eth_supportedEntryPoints", []);
      if (!Array.isArray(result) || result.length === 0) throw new Error("no entrypoints yet");
      return result;
    });
  } catch (error) {
    stopPid(altoPid);
    stopPid(anvilPid);
    throw error;
  }
  if (!supported.some(address => address.toLowerCase() === entryPoint.toLowerCase())) {
    stopPid(altoPid);
    stopPid(anvilPid);
    throw Object.assign(new Error(`alto does not serve the deployed EntryPoint (${entryPoint})`), { exitCode: 6 });
  }

  const state = {
    startedAt: new Date().toISOString(),
    chainId: versions.chainId,
    alto: versions.alto,
    rpcUrl,
    bundlerUrl,
    pids: { anvil: anvilPid, alto: altoPid },
    addresses
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function stopPid(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

export function down() {
  const state = readState();
  if (!state) {
    throw Object.assign(new Error("no owned devnet state found (.loom/devnet/state.json); refusing to guess"), {
      exitCode: 2
    });
  }
  stopPid(state.pids.alto);
  stopPid(state.pids.anvil);
  rmSync(statePath, { force: true });
  return { stopped: state.pids };
}

export async function status() {
  const state = readState();
  if (!state) return { running: false };
  const health = { rpc: false, bundler: false };
  try {
    health.rpc = (await rpc(state.rpcUrl, "eth_chainId", [])) === `0x${state.chainId.toString(16)}`;
  } catch {
    /* unhealthy */
  }
  try {
    const supported = await rpc(state.bundlerUrl, "eth_supportedEntryPoints", []);
    health.bundler = Array.isArray(supported) && supported.length > 0;
  } catch {
    /* unhealthy */
  }
  return { running: true, ...state, health };
}

export function logs(component) {
  const allowed = ["anvil", "alto", "deploy"];
  if (!allowed.includes(component)) {
    throw Object.assign(new Error(`unknown log component: ${component} (expected ${allowed.join("|")})`), {
      exitCode: 2
    });
  }
  if (!readState()) {
    throw Object.assign(new Error("no owned devnet state found; nothing to read"), { exitCode: 2 });
  }
  const path = join(stateDir, `${component}.log`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
