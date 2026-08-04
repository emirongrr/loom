import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateToolchainPins } from "./validate-toolchain-pins.mjs";

// Moving the compiler is mechanical but wide: `foundry.toml`, the npm
// dependency, every `pragma`, four `solc-select` invocations, the Kontrol
// binary name and its checksum, the validators that assert those strings, and
// the documents that state the version. Doing it by hand is how a partial bump
// happens, and a partial bump means a second compiler is reachable from the
// repository, producing bytecode no gate and no deployment manifest measured.
//
// So this does the whole sweep in one command and refuses to report success
// while any pin the `toolchain:check` gate reads still names the old version.
//
// Two things it deliberately does not guess. The build identifier comes from
// the official binary list, and the checksum is computed from the binary this
// script downloads rather than copied out of that list: `list.json` publishes a
// SHA-256 for 0.8.35 that does not match the file the same host serves, so the
// only trustworthy source for that field is the file itself.
//
// It also does not rewrite every mention of the old version. A version string
// can legitimately survive a bump - a fixture that needs two disagreeing
// versions, a document recording what a past release used - so anything outside
// the known pin shapes is reported for a human to judge, never edited.

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

/// Escapes every regular-expression metacharacter, not just the dot a version
/// string happens to contain. Versions are validated before they reach here, so
/// this is belt and braces - but a half-escape stays correct only until someone
/// widens what counts as a version.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/// Files that name versions in order to *test* version handling. Their fixtures
/// are hermetic on purpose - the pin gate's test needs two versions that
/// disagree, and this sweep's own test needs a before and an after - so
/// rewriting them turns a deliberate contrast into a broken assertion. They are
/// not pin sites, and `toolchain:check` reads none of them.
const SELF_MANAGED = new Set([
  "tools/quality/bump-solidity-version.mjs",
  "tools/quality/bump-solidity-version.test.mjs",
  "tools/quality/validate-toolchain-pins.test.mjs"
]);

/// The files a bump is allowed to touch, and the only ones the summary counts.
/// Derived from git rather than a directory walk so build output, caches, and
/// vendored dependencies can never be rewritten.
export function trackedFiles(base) {
  return execFileSync("git", ["ls-files"], { cwd: base, encoding: "utf8" })
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/// Pins the `toolchain:check` gate reads. If one of these still names the old
/// version after a sweep, the repository has two compilers and the bump failed.
function isGateRelevant(relative) {
  return (
    relative === "foundry.toml" ||
    relative === "package.json" ||
    relative.startsWith(".github/workflows/")
  );
}

/// Reads the checksum the Kontrol workflow currently verifies its download
/// against, so the sweep can replace that exact string wherever it is mirrored
/// without being told what it is.
function currentBinaryChecksum(base, files) {
  for (const relative of files) {
    if (!relative.startsWith(".github/workflows/")) continue;
    const match = readFileSync(join(base, relative.split("/").join(sep)), "utf8").match(
      /SOLC_SHA256:\s*([0-9a-f]{64})/u
    );
    if (match) return match[1];
  }
  return undefined;
}

/// The one place that decides what a "pin" looks like. Every rule is anchored
/// on the old version, so a file that merely discusses Solidity is untouched.
function replacements({ from, to, fromCommit, toCommit, fromChecksum, toChecksum }) {
  const rules = [
    { name: "pragma", from: `pragma solidity ${from};`, to: `pragma solidity ${to};` },
    { name: "foundry.toml", from: `solc_version = "${from}"`, to: `solc_version = "${to}"` },
    { name: "solc-select install", from: `solc-select install ${from}`, to: `solc-select install ${to}` },
    { name: "solc-select use", from: `solc-select use ${from}`, to: `solc-select use ${to}` },
    { name: "shell SOLC_VERSION", from: `SOLC_VERSION=${from}`, to: `SOLC_VERSION=${to}` },
    { name: "manifest solcVersion", from: `solcVersion: "${from}"`, to: `solcVersion: "${to}"` },
    {
      // Keeps whatever range prefix the manifest already used; the gate accepts
      // a caret that resolves to the pin, and changing that is not this script's
      // decision to make.
      name: "npm solc dependency",
      pattern: new RegExp(`("solc":\\s*"[\\^~]?)${escapeRegExp(from)}"`, "gu"),
      to: `$1${to}"`
    },
    { name: "documented version", from: `\`${from}\``, to: `\`${to}\`` }
  ];
  if (fromCommit !== undefined) {
    // Platform-agnostic on purpose: the same identifier appears as
    // `solc-linux-amd64-v...` in the workflow and bare in the validators.
    rules.push({
      name: "solc build identifier",
      pattern: new RegExp(`v${escapeRegExp(from)}\\+commit\\.${fromCommit}`, "gu"),
      to: `v${to}+commit.${toCommit}`
    });
  }
  if (fromChecksum !== undefined && toChecksum !== undefined) {
    rules.push({ name: "solc binary checksum", from: fromChecksum, to: toChecksum });
  }
  return rules;
}

function applyTo(source, rules) {
  let result = source;
  const applied = [];
  for (const rule of rules) {
    const before = result;
    result = rule.pattern ? result.replace(rule.pattern, rule.to) : result.split(rule.from).join(rule.to);
    if (result !== before) applied.push(rule.name);
  }
  return { result, applied };
}

/// Rewrites every pin, then reports what it could not account for. `files` is
/// injectable so the self-test can run against a fixture that is not a git
/// repository.
export function bumpSolidityVersion({
  base,
  from,
  to,
  fromCommit,
  toCommit,
  fromChecksum,
  toChecksum,
  files = trackedFiles(base)
}) {
  const rules = replacements({ from, to, fromCommit, toCommit, fromChecksum, toChecksum });
  const changed = [];
  const remaining = [];

  for (const relative of files) {
    // Lockfiles carry the version beside integrity hashes that only npm can
    // recompute, so editing them by hand would produce a lockfile that installs
    // one version and claims another. `npm install --package-lock-only`
    // regenerates them, and the closing message says so.
    if (relative.endsWith("package-lock.json")) continue;
    if (SELF_MANAGED.has(relative)) continue;

    const path = join(base, relative.split("/").join(sep));
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue; // Unreadable as text, so it holds no pin.
    }
    if (source.includes("\u0000")) continue; // Binary; rewriting it as text would corrupt it.

    const { result, applied } = applyTo(source, rules);
    const rewritten = result !== source;
    if (rewritten) {
      writeFileSync(path, result, "utf8");
      changed.push({ relative, applied });
    }
    if (result.includes(from)) {
      // `partial` is the case that actually bites. A file the sweep both edited
      // and could not finish is internally inconsistent right now - the pin
      // gate's own test, for instance, needs two disagreeing versions, so
      // moving one of them turns a deliberate contrast into a broken fixture.
      remaining.push({ relative, gateRelevant: isGateRelevant(relative), partial: rewritten });
    }
  }

  return { changed, remaining };
}

/// Resolves the build identifier from the official list, then downloads the
/// binary and hashes it. The download is the point: it is the same procedure
/// that reproduces the checksum already pinned for the current version, which
/// is what makes the new one trustworthy.
async function resolveRelease(version) {
  const host = "https://binaries.soliditylang.org/linux-amd64";
  const list = await (await fetch(`${host}/list.json`)).json();
  const build = list.builds.find(entry => entry.version === version);
  if (build === undefined) throw new Error(`solc ${version} is not published for linux-amd64`);

  const commit = build.longVersion.match(/\+commit\.([0-9a-f]+)$/u)?.[1];
  if (commit === undefined) throw new Error(`cannot read a commit hash out of "${build.longVersion}"`);

  const response = await fetch(`${host}/${build.path}`);
  if (!response.ok) throw new Error(`downloading ${build.path} failed with ${response.status}`);
  const checksum = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");

  return { commit, checksum, path: build.path };
}

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const base = process.cwd();
  const to = process.argv[2];
  if (to === undefined || !VERSION_PATTERN.test(to)) {
    console.error("usage: node tools/quality/bump-solidity-version.mjs <x.y.z> [--commit <hex>] [--sha256 <hex>]");
    process.exitCode = 1;
    return;
  }

  const from = readFileSync(join(base, "foundry.toml"), "utf8").match(/^solc_version\s*=\s*"([^"]+)"/mu)?.[1];
  if (from === undefined) throw new Error("foundry.toml has no solc_version pin to move from");
  if (!VERSION_PATTERN.test(from)) throw new Error(`foundry.toml pins "${from}", which is not an x.y.z version`);
  if (from === to) {
    console.log(`solc is already pinned at ${to}; nothing to do`);
    return;
  }

  const files = trackedFiles(base);
  const fromChecksum = currentBinaryChecksum(base, files);
  const fromCommit = files
    .map(relative => readFileSync(join(base, relative.split("/").join(sep)), "utf8"))
    .map(source => source.match(new RegExp(`v${escapeRegExp(from)}\\+commit\\.([0-9a-f]+)`, "u"))?.[1])
    .find(commit => commit !== undefined);

  const overrideCommit = readArgument("commit");
  const overrideChecksum = readArgument("sha256");
  const release =
    overrideCommit !== undefined && overrideChecksum !== undefined
      ? { commit: overrideCommit, checksum: overrideChecksum, path: `solc-linux-amd64-v${to}+commit.${overrideCommit}` }
      : await resolveRelease(to);

  console.log(`==> moving Solidity ${from} -> ${to}`);
  console.log(`    build identifier ${to}+commit.${release.commit}`);
  console.log(`    ${release.path} sha256 ${release.checksum}`);

  const { changed, remaining } = bumpSolidityVersion({
    base,
    from,
    to,
    fromCommit,
    toCommit: release.commit,
    fromChecksum,
    toChecksum: release.checksum,
    files
  });

  const counts = new Map();
  for (const file of changed) {
    for (const rule of file.applied) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  console.log(`\n==> rewrote ${changed.length} file(s)`);
  for (const [rule, count] of [...counts].sort()) console.log(`    ${rule}: ${count} file(s)`);

  const blocking = remaining.filter(entry => entry.gateRelevant);
  const reviewable = remaining.filter(entry => !entry.gateRelevant);

  const untouched = reviewable.filter(entry => !entry.partial);
  const partial = reviewable.filter(entry => entry.partial);

  if (untouched.length > 0) {
    console.log(`\n==> still mentions ${from}; decide each one yourself, this script will not guess`);
    for (const entry of untouched) console.log(`    ${entry.relative}`);
  }

  if (partial.length > 0) {
    console.log(`\n==> READ THESE: rewritten in part and still mentioning ${from}`);
    console.log("    a file holding two versions on purpose is now inconsistent; fix it before you build");
    for (const entry of partial) console.log(`    ${entry.relative}`);
  }

  const problems = validateToolchainPins(base);
  if (blocking.length > 0 || problems.length > 0) {
    console.error(`\nbump incomplete: the repository can still reach Solidity ${from}`);
    for (const entry of blocking) console.error(`  pin site untouched: ${entry.relative}`);
    for (const problem of problems) console.error(`  toolchain pin: ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log("\n==> toolchain pins agree on the new version");
  console.log("    the lockfile, artifacts, and evidence still have to be regenerated:");
  console.log("    npm install --package-lock-only && npm run verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
