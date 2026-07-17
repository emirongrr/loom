import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The core, guardian, and deployment packages are npm workspaces and share the
// root lockfile, so the root audit covers them. The account compatibility shim,
// the privacy and wallet engine SDKs, and the documentation site keep their own
// lockfiles and are audited separately.
const targets = [
  { name: "root workspace", args: ["audit", "--audit-level=low"] },
  { name: "account compatibility shim", args: ["--prefix", "packages/account", "audit", "--audit-level=low"] },
  { name: "privacy SDK", args: ["--prefix", "packages/privacy", "audit", "--audit-level=low"] },
  { name: "wallet engine SDK", args: ["--prefix", "packages/sdk", "audit", "--audit-level=low"] },
  { name: "documentation site", args: ["--prefix", "docs/site", "audit", "--audit-level=low"] }
];

for (const target of targets) {
  console.log(`\n==> ${target.name} dependency audit`);
  const result = spawnSync(npm, target.args, {
    cwd: root,
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error(`${target.name} dependency audit failed`);
  console.log(`<== ${target.name} dependency audit passed`);
}
