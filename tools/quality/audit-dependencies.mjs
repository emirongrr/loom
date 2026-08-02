import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAllowedAuditReport } from "./dependency-audit-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const policy = JSON.parse(readFileSync(new URL("./dependency-audit-policy.json", import.meta.url), "utf8"));

// The core, passkey, guardian, and deployment packages are npm workspaces and
// share the root lockfile, so the root audit covers them. Every other tree in
// the repository keeps its own lockfile and is audited separately.
//
// The rule is deliberately total: one audit target per committed lockfile, with
// no prose exceptions. `validate-audit-coverage.mjs` enforces it, because the
// list below was hand-maintained and had silently fallen behind - the mobile
// wallet example, 587 third-party packages with two high-severity advisories,
// was never audited by anything.
//
// packages/cli resolves the third-party Alto bundler into a gitignored cache at
// run time rather than committing it. That tree is external developer tooling,
// in the same category as the Foundry binaries the CLI also drives, and stays
// out of the repository; its committed lockfile holds only local `file:` links.
export const targets = [
  { name: "root workspace", args: ["audit", "--audit-level=low"] },
  { name: "account compatibility shim", args: ["--prefix", "packages/account", "audit", "--audit-level=low"] },
  {
    name: "privacy SDK",
    args: ["--prefix", "packages/privacy", "audit", "--audit-level=low", "--json"],
    lockfile: "packages/privacy/package-lock.json"
  },
  { name: "backend tracker example", args: ["--prefix", "examples/backend-userop-tracker", "audit", "--audit-level=low"] },
  { name: "web passkey example", args: ["--prefix", "examples/passkey-wallet-web", "audit", "--audit-level=low"] },
  { name: "monitoring component", args: ["--prefix", "monitoring", "audit", "--audit-level=low"] },
  { name: "wallet engine SDK", args: ["--prefix", "packages/sdk", "audit", "--audit-level=low"] },
  { name: "documentation site", args: ["--prefix", "docs/site", "audit", "--audit-level=low"] },
  { name: "CLI", args: ["--prefix", "packages/cli", "audit", "--audit-level=low"] },
  {
    name: "mobile privacy wallet example",
    args: ["--prefix", "examples/mobile-privacy-wallet", "audit", "--audit-level=low"]
  }
];

function main() {
  for (const target of targets) {
    console.log(`\n==> ${target.name} dependency audit`);
    const result = spawnSync(npm, target.args, {
      cwd: root,
      shell: process.platform === "win32",
      encoding: "utf8"
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0 && target.lockfile && policy.exceptions.some(item => item.target === target.name)) {
      throw new Error(`${target.name} dependency audit exception is stale and must be removed`);
    }
    if (result.status !== 0 && target.lockfile) {
      const exception = policy.exceptions.find(item => item.target === target.name);
      const accepted = assertAllowedAuditReport({
        report: JSON.parse(result.stdout),
        lockfile: JSON.parse(readFileSync(new URL(`../../${target.lockfile}`, import.meta.url), "utf8")),
        exception,
        root
      });
      console.warn(
        `<== ${target.name} dependency audit accepted ${accepted.advisory} until ${accepted.expiresAt}`
      );
      continue;
    }
    if (result.status !== 0) throw new Error(`${target.name} dependency audit failed`);
    console.log(`<== ${target.name} dependency audit passed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
