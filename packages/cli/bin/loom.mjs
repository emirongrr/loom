#!/usr/bin/env node
// The thin Loom CLI. Commands orchestrate the SDK and repository tooling; they
// never reimplement encoding, hashing, or manifest rules, never accept a raw
// private key as an argument, and support `--json` (one JSON object on stdout,
// diagnostics on stderr). Exit codes: 0 success, 2 input/config,
// 5 transport/health, 6 verification.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { down, logs, status, up } from "../src/devnet.mjs";
import { runDoctor, redactUrl } from "../src/doctor.mjs";
import { diffManifests, inspectManifest, rpcClient, validateManifest, verifyDeployment } from "../src/deploy.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter(arg => !arg.startsWith("--"));

// Parse `--flag value` / `--flag=value` pairs from argv. No secret is ever a
// flag value (the doctor is read-only and takes none); URLs are redacted on
// output regardless.
function flag(name) {
  const eq = args.find(arg => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at !== -1 && args[at + 1] && !args[at + 1].startsWith("--")) return args[at + 1];
  return undefined;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function emit(result) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  } else if (typeof result === "string") {
    process.stdout.write(result);
  } else {
    console.log(result);
  }
}

function fail(error) {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  } else {
    console.error(`loom: ${error?.message ?? error}`);
  }
  process.exit(exitCode);
}

const usage = `usage:
  loom devnet <up|down|status|logs <anvil|alto|deploy>> [--json]
  loom doctor --rpc-url <url> [--bundler-url <url>] [--manifest <path>]
              [--entrypoint <addr>] [--account <addr>] [--chain-id <n>]
              [--recovery-module <addr>] [--json]
  loom monitor (--rpc-url <url> | LOOM_RPC_URL) (--manifest <path> | LOOM_MANIFEST)
               [--port <n>] [--interval-ms <n>] [--tvl-tokens <addr,addr>]
  loom deploy <inspect|verify> --manifest <path> [--rpc-url <url>] [--json]
  loom manifest <validate --manifest <path> [--rpc-url <url>]
                 | diff --old <path> --new <path>> [--json]

devnet:   pinned local stack (anvil + Loom contracts + Alto bundler); composition
          from devnet/versions.json, ownership from .loom/devnet/state.json.
doctor:   read-only production-operation diagnostics — chain, EntryPoint and
          SenderCreator code, manifest code hashes, native P-256, bundler, and
          account safety state. Exit 6 on any verification failure. Endpoints are
          redacted in every output.
monitor:  connect a deployment from its manifest and export TVL/throughput
          metrics on /metrics for Prometheus + Grafana (the monitoring/ stack).
          Supply the RPC URL via LOOM_RPC_URL to keep a token-bearing URL out of
          argv; --rpc-url is a convenience for non-secret endpoints.
deploy:   read-only deployment inspection and verification. inspect shows a
          manifest, labelling each contract verified (chain-confirmed with
          --rpc-url) or asserted; verify fails (exit 6) on a code-hash mismatch.
manifest: validate a manifest against the schema (and on chain with --rpc-url),
          or diff two manifests, flagging authority/EntryPoint/module changes.`;

// Human-readable status glyphs.
const GLYPH = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "----" };

async function doctorCommand() {
  const rpcUrl = flag("rpc-url");
  if (!rpcUrl) {
    throw Object.assign(new Error("loom doctor requires --rpc-url"), { exitCode: 2 });
  }
  const bundlerUrl = flag("bundler-url");
  const manifestPath = flag("manifest");
  const account = flag("account");
  const chainIdRaw = flag("chain-id");
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;

  // Transports are built here (the doctor library takes them injected).
  const { createJsonRpcClient } = await import("@loom/deployment");
  const rpc = createJsonRpcClient(rpcUrl);
  const bundlerRpc = bundlerUrl ? createJsonRpcClient(bundlerUrl) : undefined;
  let stateTransport;
  let chainId = chainIdRaw !== undefined ? Number(chainIdRaw) : manifest?.chainId;
  if (account && chainId !== undefined) {
    const { createRpcStateTransport } = await import("@loom/sdk");
    stateTransport = createRpcStateTransport({ endpoint: rpcUrl });
  }
  const altoVersion = JSON.parse(readFileSync(join(repoRoot, "devnet", "versions.json"), "utf8")).alto;

  const report = await runDoctor({
    rpc,
    bundlerRpc,
    stateTransport,
    manifest,
    chainId,
    account,
    entryPoint: flag("entrypoint"),
    recoveryModule: flag("recovery-module"),
    altoVersion
  });

  if (json) {
    // Redact endpoints in the machine-readable output too.
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: report.ok,
          endpoints: { rpc: redactUrl(rpcUrl), bundler: redactUrl(bundlerUrl) },
          checks: report.checks
        },
        null,
        2
      )}\n`
    );
  } else {
    console.log(`loom doctor  rpc=${redactUrl(rpcUrl)}${bundlerUrl ? `  bundler=${redactUrl(bundlerUrl)}` : ""}`);
    for (const entry of report.checks) {
      console.log(`  [${GLYPH[entry.status] ?? entry.status}] ${entry.name}: ${entry.detail}`);
    }
    console.log(report.ok ? "\nAll checks passed." : "\nOne or more checks failed.");
  }
  if (!report.ok) process.exit(6);
}

function readManifest(flagName = "manifest") {
  const path = flag(flagName);
  if (!path) throw Object.assign(new Error(`--${flagName} is required`), { exitCode: 2 });
  return JSON.parse(readFileSync(path, "utf8"));
}

async function deployCommand(command) {
  const rpcUrl = flag("rpc-url");
  const rpc = rpcUrl ? rpcClient(rpcUrl) : undefined;
  if (command === "inspect") {
    const view = await inspectManifest(readManifest(), { rpc });
    if (json) {
      emit(view);
    } else {
      console.log(`deployment ${view.manifestHash}  chain ${view.chainId} (${view.releaseChannel})  release ${view.contractRelease}`);
      for (const [name, c] of [["entryPoint", view.entryPoint], ["factory", view.factory], ["implementation", view.implementation]]) {
        console.log(`  [${c.state}] ${name}: ${c.address}`);
      }
      for (const m of view.modules) console.log(`  [${m.state}] module ${m.type} (${m.status}): ${m.address}`);
    }
    return;
  }
  if (command === "verify") {
    if (!rpc) throw Object.assign(new Error("loom deploy verify requires --rpc-url"), { exitCode: 2 });
    const report = await verifyDeployment(readManifest(), rpc);
    if (json) emit(report);
    else {
      for (const c of report.checks) console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.label}: ${c.address}`);
      console.log("\nAll component code hashes match.");
    }
    return;
  }
  throw Object.assign(new Error(`unknown deploy command: ${command}`), { exitCode: 2 });
}

async function manifestCommand(command) {
  if (command === "validate") {
    const rpcUrl = flag("rpc-url");
    const report = await validateManifest(readManifest(), { rpc: rpcUrl ? rpcClient(rpcUrl) : undefined });
    if (json) emit(report);
    else {
      console.log(`manifest ${report.manifestHash}  chain ${report.chainId} (${report.releaseChannel})  schema ok`);
      if (report.onChain) console.log(report.onChain.ok ? "on-chain code hashes match" : `on-chain failures: ${report.onChain.failures.join(", ")}`);
    }
    return;
  }
  if (command === "diff") {
    const result = diffManifests(readManifest("old"), readManifest("new"));
    if (json) {
      emit(result);
    } else {
      console.log(`${result.from} -> ${result.to}  ${result.compatible ? "compatible" : "INCOMPATIBLE"}`);
      for (const c of result.changes) console.log(`  [${c.severity}] ${c.field}: ${c.from ?? "∅"} -> ${c.to ?? "∅"}`);
      if (result.changes.length === 0) console.log("  (no differences)");
    }
    if (!result.compatible) process.exit(6);
    return;
  }
  throw Object.assign(new Error(`unknown manifest command: ${command}`), { exitCode: 2 });
}

try {
  const [group, command, argument] = positional;
  if (group === "doctor") {
    await doctorCommand();
    process.exit(0);
  } else if (group === "deploy") {
    if (!command) throw Object.assign(new Error(`loom deploy needs a subcommand (inspect|verify)`), { exitCode: 2 });
    await deployCommand(command);
    process.exit(0);
  } else if (group === "manifest") {
    if (!command) throw Object.assign(new Error(`loom manifest needs a subcommand (validate|diff)`), { exitCode: 2 });
    await manifestCommand(command);
    process.exit(0);
  } else if (group === "monitor") {
    // Start the monitoring exporter as a child process — a clean boundary that
    // keeps the CLI decoupled from the monitoring component's dependencies, and
    // the parent stays alive until the child exits.
    //
    // The RPC URL may be supplied with `--rpc-url` or via the LOOM_RPC_URL
    // environment variable. A `--rpc-url` value is visible in this process's
    // argv (process listings) for the exporter's whole lifetime; if the URL
    // embeds a secret token, set LOOM_RPC_URL instead to keep it out of argv.
    // Either way it reaches the exporter through the environment, never the
    // child's argv.
    const rpcUrl = flag("rpc-url") ?? process.env.LOOM_RPC_URL;
    const manifestPath = flag("manifest") ?? process.env.LOOM_MANIFEST;
    if (!rpcUrl || !manifestPath) {
      throw Object.assign(
        new Error("loom monitor requires an RPC URL (--rpc-url or LOOM_RPC_URL) and a manifest (--manifest or LOOM_MANIFEST)"),
        { exitCode: 2 }
      );
    }
    const server = join(repoRoot, "monitoring", "server.mjs");
    const child = spawn(process.execPath, [server], {
      stdio: "inherit",
      env: {
        ...process.env,
        LOOM_RPC_URL: rpcUrl,
        LOOM_MANIFEST: manifestPath,
        ...(flag("port") ? { LOOM_METRICS_PORT: flag("port") } : {}),
        ...(flag("interval-ms") ? { LOOM_POLL_INTERVAL_MS: flag("interval-ms") } : {}),
        ...(flag("tvl-tokens") ? { LOOM_TVL_TOKENS: flag("tvl-tokens") } : {})
      }
    });
    child.on("exit", code => process.exit(code ?? 0));
  } else if (group !== "devnet" || !command) {
    if (args.includes("--help") || args.length === 0) {
      console.log(usage);
      process.exit(0);
    }
    throw Object.assign(new Error(`unknown command; ${usage}`), { exitCode: 2 });
  } else {
    switch (command) {
    case "up":
      emit(await up());
      break;
    case "down":
      emit(down());
      break;
    case "status":
      emit(await status());
      break;
    case "logs":
      emit(logs(argument));
      break;
      default:
        throw Object.assign(new Error(`unknown devnet command: ${command}`), { exitCode: 2 });
    }
  }
} catch (error) {
  fail(error);
}
