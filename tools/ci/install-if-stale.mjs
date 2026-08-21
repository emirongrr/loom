#!/usr/bin/env node
// Install a workspace's dependencies only when they are actually out of date.
//
// `npm ci` deletes node_modules and rebuilds it from the lockfile. That is the
// right thing in CI, where the tree starts empty and must match the lockfile
// exactly. On a developer machine it is mostly waste, and on Windows it is
// worse than waste: the delete fails on any file another process has open --
// a running dev server holds `@rolldown/binding-win32-x64-msvc/*.node` -- and
// npm gives up partway, leaving a tree with packages half removed. Verification
// then fails with `Cannot find package 'viem'`, which says nothing about the
// code and everything about the file lock.
//
// So: install when the lockfile has moved since the last install, and skip when
// it has not. The stamp records the lockfile's hash together with the runtime
// identity, because native bindings are built for a particular platform, arch,
// and ABI -- a tree installed under a different one is stale even though the
// lockfile is unchanged.
//
// What this gives up: `npm ci` also guarantees nothing has been edited inside
// node_modules by hand, and a hash of the lockfile cannot see that. CI keeps
// the strong guarantee -- it always installs, because the tree starts empty and
// CI is set -- and `LOOM_FORCE_INSTALL=1` restores it here.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const forced = Boolean(process.env.CI) || process.env.LOOM_FORCE_INSTALL === "1";

export function installStamp(lockfile) {
  return createHash("sha256")
    .update(lockfile)
    .update(`\0${process.version}\0${process.platform}\0${process.arch}`)
    .digest("hex");
}

export function installDecision({ prefix, readFile, exists, force }) {
  if (force) return { install: true, reason: "forced" };
  const modules = join(prefix, "node_modules");
  if (!exists(modules)) return { install: true, reason: "no node_modules" };

  const lock = readFile(join(prefix, "package-lock.json"));
  // No lockfile means nothing to compare against, so never claim it is fresh.
  if (lock === null) return { install: true, reason: "no lockfile" };

  const wanted = installStamp(lock);
  const found = readFile(join(modules, ".loom-install-stamp"));
  if (found === null) return { install: true, reason: "never stamped", stamp: wanted };
  if (found.trim() !== wanted) return { install: true, reason: "lockfile changed", stamp: wanted };
  return { install: false, reason: "up to date", stamp: wanted };
}

const read = path => existsSync(path) ? readFileSync(path, "utf8") : null;

function main(prefixes) {
  for (const prefix of prefixes) {
    const decision = installDecision({ prefix, readFile: read, exists: existsSync, force: forced });
    if (!decision.install) {
      console.log(`==> ${prefix}: dependencies ${decision.reason}, skipping install`);
      continue;
    }
    console.log(`==> ${prefix}: installing (${decision.reason})`);
    const result = spawnSync(npm, ["--prefix", prefix, "ci"], { stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    // Stamped only after a clean exit, so an install that died partway is
    // retried rather than remembered as good.
    const lock = read(join(prefix, "package-lock.json"));
    if (lock !== null) writeFileSync(join(prefix, "node_modules", ".loom-install-stamp"), `${installStamp(lock)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prefixes = process.argv.slice(2);
  if (prefixes.length === 0) {
    console.error("usage: install-if-stale.mjs <workspace-prefix> [...]");
    process.exit(2);
  }
  main(prefixes);
}
