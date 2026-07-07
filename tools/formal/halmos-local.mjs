import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const venv = path.join(root, ".halmos-venv");
const python = process.env.PYTHON || "python";

function bin(name) {
  return process.platform === "win32" ? path.join(venv, "Scripts", `${name}.exe`) : path.join(venv, "bin", name);
}

function run(label, cmd, args, options = {}) {
  console.log(`\n==> ${label}`);
  const forgeBin = path.join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin");
  const env = {
    ...process.env,
    PATH: process.platform === "win32" ? `${forgeBin};${process.env.PATH}` : process.env.PATH,
    ...options.env,
  };
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false, env });
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
  console.log(`<== ${label} passed`);
}

function ensureInstalled() {
  if (!existsSync(bin("halmos"))) throw new Error("Halmos is not installed. Run `npm run halmos:install` first.");
}

const subcommand = process.argv[2] ?? "help";

if (subcommand === "install") {
  if (!existsSync(bin("python"))) run("Create Halmos virtualenv", python, ["-m", "venv", venv]);
  run("Install pinned Halmos", bin("python"), ["-m", "pip", "install", "halmos==0.3.3"]);
} else if (subcommand === "version") {
  ensureInstalled();
  run("Halmos version", bin("halmos"), ["--version"]);
} else if (subcommand === "test") {
  ensureInstalled();
  const contracts = [
    "LoomAccountInitializationFormal",
    "LoomAccountAuthorityFormal",
    "LoomAccountExecutionFormal",
    "LoomAccountRecoveryFormal",
    "LoomAccountMigrationFormal",
  ];
  for (const contract of contracts) {
    run(`Halmos ${contract}`, bin("halmos"), ["--contract", contract]);
  }
} else {
  console.log("usage: node tools/formal/halmos-local.mjs <install|version|test>");
}
