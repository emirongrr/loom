import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Three supply-chain properties that are easy to state and easy to lose:
//
//   1. Exactly one Solidity version is pinned across every place that compiles
//      the contracts. A second version reachable from the repository produces
//      different bytecode than the gates and the deployment manifest measure,
//      which quietly voids any reproducibility claim made about them.
//   2. Every GitHub Action runs at an immutable commit. A moving tag lets a
//      compromised or merely retagged upstream execute new code in jobs that
//      have repository checkout access.
//   3. Nothing pipes a remote script straight into a shell, and nothing fetches
//      one from a branch ref. A pinned commit plus a checksum is the same
//      convenience without the "whatever upstream has today" part.
//
// This runs in `verify:quick`, so drift fails before review rather than during
// an audit.

function workflowFiles(base) {
  const directory = join(base, ".github", "workflows");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map(name => ({ relative: `.github/workflows/${name}`, source: readFileSync(join(directory, name), "utf8") }));
}

/// Every compiler pin in the repository, tagged with where it came from so a
/// failure names the file to edit rather than just the mismatch.
function solidityPins(base, fail) {
  const pins = [];

  const foundry = readFileSync(join(base, "foundry.toml"), "utf8").match(/^solc_version\s*=\s*"([^"]+)"/mu);
  if (foundry) pins.push({ source: "foundry.toml", version: foundry[1] });
  else fail("foundry.toml: no solc_version pin found");

  const packageJson = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const declared = packageJson.devDependencies?.solc ?? packageJson.dependencies?.solc;
  if (declared !== undefined) {
    pins.push({ source: "package.json (solc dependency)", version: declared.replace(/^[\^~]/u, "") });
  }

  for (const { relative, source } of workflowFiles(base)) {
    for (const match of source.matchAll(/solc-select\s+(?:install|use)\s+([0-9]+\.[0-9]+\.[0-9]+)/gu)) {
      pins.push({ source: `${relative} (solc-select)`, version: match[1] });
    }
    for (const match of source.matchAll(/solc-[a-z0-9-]+-v([0-9]+\.[0-9]+\.[0-9]+)\+commit\.[0-9a-f]+/gu)) {
      pins.push({ source: `${relative} (solc binary)`, version: match[1] });
    }
  }

  return pins;
}

function validateSolidityVersion(base, fail) {
  const pins = solidityPins(base, fail);
  if (pins.length === 0) {
    fail("no Solidity version pin found anywhere; the compiler must be pinned");
    return;
  }

  const versions = new Set(pins.map(pin => pin.version));
  if (versions.size > 1) {
    fail(`Solidity version pins disagree: ${pins.map(pin => `${pin.source} => ${pin.version}`).join("; ")}`);
  }
}

function validateActionPinning(base, fail) {
  for (const { relative, source } of workflowFiles(base)) {
    source.split("\n").forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/u);
      if (!match) return;
      const reference = match[1];
      // Local composite actions and reusable workflows move with the commit
      // under test, so they need no separate pin.
      if (reference.startsWith("./")) return;
      if (!/@[0-9a-f]{40}$/u.test(reference)) {
        fail(`${relative}:${index + 1}: action must be pinned to a 40-character commit SHA, found "${reference}"`);
      }
    });
  }
}

function validateRemoteScriptExecution(base, fail) {
  for (const { relative, source } of workflowFiles(base)) {
    source.split("\n").forEach((line, index) => {
      if (!/\bcurl\b|\bwget\b/u.test(line)) return;
      if (/\|\s*(?:sh|bash|zsh)\b/u.test(line)) {
        fail(`${relative}:${index + 1}: do not pipe a downloaded script into a shell; download, verify a checksum, then run`);
      }
      const branchRef = line.match(/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/(main|master|HEAD|develop)\//u);
      if (branchRef) {
        fail(`${relative}:${index + 1}: fetches from the moving ref "${branchRef[1]}"; pin a commit SHA`);
      }
    });
  }
}

export function validateToolchainPins(base = process.cwd()) {
  const failures = [];
  const fail = message => failures.push(message);
  validateSolidityVersion(base, fail);
  validateActionPinning(base, fail);
  validateRemoteScriptExecution(base, fail);
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validateToolchainPins();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`toolchain pin: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("toolchain pins ok: one Solidity version, every action SHA-pinned, no unpinned remote scripts");
  }
}
