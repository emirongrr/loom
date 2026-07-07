import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const leanRoot = path.join(root, "formal", "lean");
const toolchain = readFileSync(path.join(leanRoot, "lean-toolchain"), "utf8").trim();
const toolchainDir = toolchain.replace("/", "--").replace(":", "---");
const elanToolchainBin = path.join(process.env.USERPROFILE || "", ".elan", "toolchains", toolchainDir, "bin");

function run(label, cmd, args) {
  console.log(`\n==> ${label}`);
  const env = { ...process.env, PATH: process.platform === "win32" ? `${elanToolchainBin};${process.env.PATH}` : process.env.PATH };
  const result = spawnSync(cmd, args, { cwd: leanRoot, stdio: "inherit", shell: false, env });
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
  console.log(`<== ${label} passed`);
}

const subcommand = process.argv[2] ?? "help";

if (subcommand === "build") {
  const lean = process.platform === "win32" ? path.join(elanToolchainBin, "lean.exe") : "lean";
  const lake = process.platform === "win32" ? path.join(elanToolchainBin, "lake.exe") : "lake";
  if (process.platform === "win32" && (!existsSync(lean) || !existsSync(lake))) {
    throw new Error(`Lean toolchain is not installed at ${elanToolchainBin}. Install elan and run \`lake build\` once.`);
  }
  run("Lean version", lean, ["--version"]);
  run("Lake build", lake, ["build"]);
} else {
  console.log("usage: node tools/formal/lean-local.mjs <build>");
}
