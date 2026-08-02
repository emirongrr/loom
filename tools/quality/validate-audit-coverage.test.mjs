import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAuditCoverage } from "./validate-audit-coverage.mjs";

/// A throwaway git repository with the given lockfiles committed, so the checker
/// reads a real `git ls-files` rather than a stubbed one.
function repository(lockfiles) {
  const base = mkdtempSync(join(tmpdir(), "loom-audit-coverage-"));
  const git = args => execFileSync("git", args, { cwd: base, stdio: "pipe" });
  git(["init", "-q"]);
  for (const lockfile of lockfiles) {
    const directory = join(base, ...lockfile.split("/").slice(0, -1));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(base, lockfile), "{}\n");
  }
  git(["add", "-A"]);
  return base;
}

const rootTarget = { name: "root workspace", args: ["audit"] };
const prefixed = (name, directory) => ({ name, args: ["--prefix", directory, "audit"] });

test("a target for every lockfile passes", () => {
  const cwd = repository(["package-lock.json", "packages/sdk/package-lock.json"]);
  const auditTargets = [rootTarget, prefixed("wallet engine SDK", "packages/sdk")];
  assert.deepEqual(validateAuditCoverage({ cwd, auditTargets }), []);
});

test("a committed lockfile with no target fails", () => {
  const cwd = repository(["package-lock.json", "examples/mobile-privacy-wallet/package-lock.json"]);
  const problems = validateAuditCoverage({ cwd, auditTargets: [rootTarget] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /examples\/mobile-privacy-wallet\/package-lock\.json is committed but no dependency audit target covers it/u);
});

test("a target whose lockfile is gone fails as a stale coverage claim", () => {
  const cwd = repository(["package-lock.json"]);
  const auditTargets = [rootTarget, prefixed("removed package", "packages/removed")];
  const problems = validateAuditCoverage({ cwd, auditTargets });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"removed package" expects packages\/removed\/package-lock\.json, which is not tracked/u);
});

test("two targets for one lockfile are reported", () => {
  const cwd = repository(["package-lock.json", "packages/sdk/package-lock.json"]);
  const auditTargets = [rootTarget, prefixed("first", "packages/sdk"), prefixed("second", "packages/sdk")];
  const problems = validateAuditCoverage({ cwd, auditTargets });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /two audit targets/u);
});

test("a missing root lockfile is reported rather than passing quietly", () => {
  const cwd = repository(["packages/sdk/package-lock.json"]);
  const auditTargets = [rootTarget, prefixed("wallet engine SDK", "packages/sdk")];
  const problems = validateAuditCoverage({ cwd, auditTargets });
  assert.ok(problems.some(problem => /root workspace audit would cover nothing/u.test(problem)));
});

test("a repository with no lockfiles fails rather than reporting success", () => {
  const cwd = repository([]);
  const problems = validateAuditCoverage({ cwd, auditTargets: [rootTarget] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no tracked lockfiles/u);
});
