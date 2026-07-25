import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertAllowedAuditReport } from "./dependency-audit-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const policy = JSON.parse(readFileSync(new URL("./dependency-audit-policy.json", import.meta.url), "utf8"));

// The core, guardian, and deployment packages are npm workspaces and share the
// root lockfile, so the root audit covers them. The account compatibility shim,
// the privacy and wallet engine SDKs, the backend tracker example, and the
// documentation site keep their own lockfiles and are audited separately.
//
// packages/cli has no committed dependencies, so it is covered by the root
// audit like any workspace-free package. It resolves the third-party Alto
// bundler into a gitignored cache at run time rather than committing it — that
// tree is external developer tooling, in the same category as the Foundry
// binaries the CLI also drives, and is intentionally kept out of the repo.
const targets = [
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
  { name: "documentation site", args: ["--prefix", "docs/site", "audit", "--audit-level=low"] }
];

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
