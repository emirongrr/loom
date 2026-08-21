import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { installDecision, installStamp } from "./install-if-stale.mjs";

const world = (files) => ({
  readFile: path => Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null,
  exists: path => Object.prototype.hasOwnProperty.call(files, path)
});

const lock = '{"lockfileVersion":3,"packages":{}}';
const fresh = (prefix = "app") => ({
  [join(prefix, "node_modules")]: "",
  [join(prefix, "package-lock.json")]: lock,
  [join(prefix, "node_modules", ".loom-install-stamp")]: `${installStamp(lock)}
`
});

const decide = (files, force = false) =>
  installDecision({ prefix: "app", ...world(files), force });

test("an unchanged lockfile means no install", () => {
  assert.equal(decide(fresh()).install, false);
});

test("a changed lockfile means install", () => {
  const files = fresh();
  files[join("app", "package-lock.json")] = '{"lockfileVersion":3,"packages":{"":{}}}';
  assert.equal(decide(files).reason, "lockfile changed");
});

// The failure that started this: a tree half-deleted by an interrupted install
// has no stamp, and must not be mistaken for a good one.
test("a tree that was never stamped is installed", () => {
  const files = fresh();
  delete files[join("app", "node_modules", ".loom-install-stamp")];
  assert.equal(decide(files).install, true);
});

test("no node_modules at all means install", () => {
  assert.equal(decide({}).reason, "no node_modules");
});

// Without a lockfile there is nothing to prove freshness with, so the answer is
// "install", never "probably fine".
test("a workspace without a lockfile is never called fresh", () => {
  const files = fresh();
  delete files[join("app", "package-lock.json")];
  assert.equal(decide(files).install, true);
});

test("CI and an explicit force always install", () => {
  assert.equal(decide(fresh(), true).reason, "forced");
});

// Native bindings are built for one platform, arch, and ABI. The same lockfile
// under a different runtime describes a different tree.
test("the stamp changes with the runtime, not only the lockfile", () => {
  const before = installStamp(lock);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos", configurable: true });
  const after = installStamp(lock);
  Object.defineProperty(process, "platform", platform);
  assert.notEqual(before, after);
});
