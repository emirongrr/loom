import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  {
    name: "account lifecycle intent builders",
    command: npm,
    args: ["--prefix", "packages/account", "test"]
  },
  {
    name: "entrypoint account lifecycle",
    command: forge,
    args: ["test", "--match-contract", "EntryPointIntegrationTest", "-vvv"]
  },
  {
    name: "sovereign migration lifecycle",
    command: forge,
    args: ["test", "--match-contract", "SovereignMigrationTest", "-vvv"]
  },
  {
    name: "vault withdrawal lifecycle",
    command: forge,
    args: ["test", "--match-contract", "VaultHookTest", "-vvv"]
  }
];

for (const step of steps) {
  const started = performance.now();
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    shell: process.platform === "win32" && step.command.endsWith(".cmd"),
    stdio: "inherit"
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  if (result.status !== 0) throw new Error(`${step.name} failed after ${seconds}s`);
  console.log(`<== ${step.name} passed in ${seconds}s`);
}

console.log("\nlocal lifecycle rehearsal passed");
