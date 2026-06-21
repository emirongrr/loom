import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const venv = path.join(root, ".certora-venv");
const python = process.env.PYTHON || "python";

function bin(name) {
  return process.platform === "win32"
    ? path.join(venv, "Scripts", `${name}.exe`)
    : path.join(venv, "bin", name);
}

function command(name) {
  if (process.platform !== "win32") return path.join(venv, "bin", name);
  const exe = path.join(venv, "Scripts", `${name}.exe`);
  const cmd = path.join(venv, "Scripts", `${name}.cmd`);
  return existsSync(exe) ? exe : cmd;
}

function run(label, cmd, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
  console.log(`<== ${label} passed`);
}

function ensureInstalled() {
  if (!existsSync(command("certoraRun"))) {
    throw new Error("Certora CLI is not installed. Run `npm run certora:install` first.");
  }
}

const subcommand = process.argv[2] ?? "help";

if (subcommand === "install") {
  if (!existsSync(bin("python"))) {
    run("Create Certora virtualenv", python, ["-m", "venv", venv]);
  }
  run("Upgrade pip", bin("python"), ["-m", "pip", "install", "--upgrade", "pip"]);
  run("Install pinned Certora CLI", bin("python"), ["-m", "pip", "install", "-r", "formal/certora/requirements.txt"]);
} else if (subcommand === "version") {
  ensureInstalled();
  run("Certora CLI version", command("certoraRun"), ["--version"]);
} else if (subcommand === "compile") {
  ensureInstalled();
  const conf = process.argv[3] ?? "formal/certora/conf/loom-account-authority.conf";
  const args = [conf, "--compilation_steps_only"];
  if (process.env.SOLC) args.push("--solc", process.env.SOLC);
  if (process.env.SOLC_ALLOW_PATH) args.push("--solc_allow_path", process.env.SOLC_ALLOW_PATH);
  run("Certora compile-only", command("certoraRun"), args);
} else if (subcommand === "run") {
  ensureInstalled();
  const conf = process.argv[3] ?? "formal/certora/conf/loom-account-authority.conf";
  if (!process.env.CERTORAKEY) {
    throw new Error("CERTORAKEY is required to run Certora locally. Set it only in your local shell or secret manager.");
  }
  run("Certora prover", command("certoraRun"), [conf, "--wait_for_results=all"]);
} else {
  console.log("usage: node tools/certora-local.mjs <install|version|compile|run> [conf]");
}
