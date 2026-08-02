import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { targets } from "./audit-dependencies.mjs";

// This repository is a hybrid monorepo: four packages are npm workspaces sharing
// the root lockfile, and every other tree keeps its own. `npm audit` only sees
// one lockfile at a time, so dependency coverage is exactly the hand-maintained
// target list in `audit-dependencies.mjs` — and a hand-maintained list that
// nothing checks is a list that falls behind. It had: the mobile wallet example
// carried 587 third-party packages and two high-severity advisories that no gate
// ever looked at.
//
// The rule enforced here is total and needs no judgement: one audit target per
// committed lockfile, in both directions. A new tree with a lockfile fails until
// it is audited, and a target for a tree that no longer has one fails as a stale
// claim of coverage.

const ROOT_LOCKFILE = "package-lock.json";

export function trackedLockfiles(cwd = process.cwd()) {
  const result = spawnSync("git", ["ls-files", "*package-lock.json"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("could not list tracked lockfiles");
  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .sort();
}

/// The directory an audit target runs in. The root target has no `--prefix`.
function targetDirectory(target) {
  const index = target.args.indexOf("--prefix");
  return index === -1 ? "" : target.args[index + 1];
}

export function validateAuditCoverage({ cwd = process.cwd(), auditTargets = targets } = {}) {
  const failures = [];
  const lockfiles = trackedLockfiles(cwd);

  if (lockfiles.length === 0) {
    return ["no tracked lockfiles found; the checker is pointed at the wrong repository"];
  }
  if (!lockfiles.includes(ROOT_LOCKFILE)) {
    failures.push(`${ROOT_LOCKFILE} is not tracked; the root workspace audit would cover nothing`);
  }

  const audited = new Map();
  for (const target of auditTargets) {
    const directory = targetDirectory(target);
    const lockfile = directory === "" ? ROOT_LOCKFILE : `${directory}/${ROOT_LOCKFILE}`;
    if (audited.has(lockfile)) {
      failures.push(`${lockfile} has two audit targets ("${audited.get(lockfile)}" and "${target.name}")`);
      continue;
    }
    audited.set(lockfile, target.name);
  }

  for (const lockfile of lockfiles) {
    if (!audited.has(lockfile)) {
      failures.push(`${lockfile} is committed but no dependency audit target covers it`);
    }
  }
  for (const [lockfile, name] of audited) {
    if (!lockfiles.includes(lockfile)) {
      failures.push(`audit target "${name}" expects ${lockfile}, which is not tracked`);
    }
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validateAuditCoverage();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`audit coverage: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`audit coverage ok: ${trackedLockfiles().length} committed lockfiles, each with a dependency audit target`);
  }
}
