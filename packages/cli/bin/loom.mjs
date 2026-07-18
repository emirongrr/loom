#!/usr/bin/env node
// The thin Loom CLI. Commands orchestrate the SDK and repository tooling; they
// never reimplement encoding, hashing, or manifest rules, never accept a raw
// private key as an argument, and support `--json` (one JSON object on stdout,
// diagnostics on stderr). Exit codes: 0 success, 2 input/config,
// 5 transport/health, 6 verification.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { down, logs, status, up } from "../src/devnet.mjs";
import { runDoctor, redactUrl } from "../src/doctor.mjs";

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

devnet: pinned local stack (anvil + Loom contracts + Alto bundler); composition
        from devnet/versions.json, ownership from .loom/devnet/state.json.
doctor: read-only production-operation diagnostics — chain, EntryPoint and
        SenderCreator code, manifest code hashes, native P-256, bundler, and
        account safety state. Exit 6 on any verification failure. Endpoints are
        redacted in every output.`;

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

try {
  const [group, command, argument] = positional;
  if (group === "doctor") {
    await doctorCommand();
    process.exit(0);
  }
  if (group !== "devnet" || !command) {
    if (args.includes("--help") || args.length === 0) {
      console.log(usage);
      process.exit(0);
    }
    throw Object.assign(new Error(`unknown command; ${usage}`), { exitCode: 2 });
  }
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
} catch (error) {
  fail(error);
}
