#!/usr/bin/env node
// The thin Loom CLI. Commands orchestrate the SDK and repository tooling; they
// never reimplement encoding, hashing, or manifest rules, never accept a raw
// private key as an argument, and support `--json` (one JSON object on stdout,
// diagnostics on stderr). Exit codes: 0 success, 2 input/config,
// 5 transport/health, 6 verification.

import { down, logs, status, up } from "../src/devnet.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter(arg => !arg.startsWith("--"));

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

const usage = `usage: loom devnet <up|down|status|logs <anvil|alto|deploy>> [--json]

Pinned local devnet (anvil + Loom contracts + Alto bundler); composition is
read from devnet/versions.json and ownership from .loom/devnet/state.json.`;

try {
  const [group, command, argument] = positional;
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
