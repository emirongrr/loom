import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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
  { name: "root workspace", args: ["audit"] },
  { name: "account compatibility shim", args: ["--prefix", "packages/account", "audit"] },
  { name: "privacy SDK", args: ["--prefix", "packages/privacy", "audit"] },
  { name: "backend tracker example", args: ["--prefix", "examples/backend-userop-tracker", "audit"] },
  { name: "web passkey example", args: ["--prefix", "examples/passkey-wallet-web", "audit"] },
  { name: "monitoring component", args: ["--prefix", "monitoring", "audit"] },
  { name: "wallet engine SDK", args: ["--prefix", "packages/sdk", "audit"] },
  { name: "documentation site", args: ["--prefix", "docs/site", "audit"] }
];

// Advisories with no safe upstream fix, reviewed and accepted with a recorded
// reason. Each entry is scoped to the single target that surfaces it, so the
// same advisory appearing in a different tree still fails the gate. Keep this
// list short and revisit it whenever a real fix lands, so an acceptance never
// outlives the constraint that justified it.
const allowlist = {
  "privacy SDK": [
    {
      id: "GHSA-mh99-v99m-4gvg",
      reason:
        "brace-expansion DoS reachable only through snarkjs' build and proving " +
        "tooling (ejs -> jake -> filelist -> minimatch), never at the privacy " +
        "runtime boundary, which parses no untrusted brace patterns. No fix " +
        "satisfies the tree: the only patched release (5.0.8) drops the CommonJS " +
        "default export that this minimatch requires and breaks it at run time."
    }
  ],
  "documentation site": [
    {
      id: "GHSA-qwww-vcr4-c8h2",
      reason:
        "react-router RSC-mode CSRF pulled transitively by vocs, which pins " +
        "react-router ^7 and builds a static site with client-side routing. The " +
        "vulnerable path is React Server Components server actions, which the " +
        "static docs build never runs. The only fix (8.3.0) is a major outside " +
        "vocs' supported range and breaks the build."
    }
  ]
};

// npm reports one advisory object per directly-affected package and echoes it
// down the tree as bare dependency names; the object carries the GHSA id in its
// url. Collect the concrete advisories so a transitive echo is not double-counted.
function collectAdvisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      const id = via.url.split("/").pop();
      if (!found.has(id)) {
        found.set(id, { id, title: via.title ?? "", package: via.name ?? vuln.name });
      }
    }
  }
  return [...found.values()];
}

let failed = false;
for (const target of targets) {
  console.log(`\n==> ${target.name} dependency audit`);
  const result = spawnSync(npm, [...target.args, "--json"], {
    cwd: root,
    shell: process.platform === "win32",
    encoding: "utf8"
  });

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // A non-JSON payload means the audit itself could not run (offline, registry
    // error, tooling failure) — that is a hard failure, not a clean tree.
    console.error(result.stdout || result.stderr || "no output");
    throw new Error(`${target.name} dependency audit could not be evaluated`);
  }

  const allowed = new Map((allowlist[target.name] ?? []).map((entry) => [entry.id, entry]));
  const advisories = collectAdvisories(report);
  const unresolved = advisories.filter((advisory) => !allowed.has(advisory.id));
  const suppressed = advisories.filter((advisory) => allowed.has(advisory.id));

  for (const advisory of suppressed) {
    console.log(`    accepted ${advisory.id} (${advisory.package}): ${allowed.get(advisory.id).reason}`);
  }

  if (unresolved.length > 0) {
    failed = true;
    for (const advisory of unresolved) {
      console.error(`    unresolved ${advisory.id} (${advisory.package}): ${advisory.title}`);
    }
    console.error(`<== ${target.name} dependency audit failed`);
    continue;
  }

  console.log(`<== ${target.name} dependency audit passed`);
}

if (failed) throw new Error("dependency audit failed");
