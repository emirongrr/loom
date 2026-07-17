import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The CLI is a thin orchestrator. These tests pin the guarantees that do not
// need a live devnet: argument handling, exit-code contract, JSON shape, and
// the ownership discipline that makes `down`/`logs` refuse to act unless the
// CLI itself recorded the state it would touch. Bringing a real stack up is
// covered end to end by tools/e2e/bundler-devnet.mjs.

const bin = fileURLToPath(new URL("../bin/loom.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const statePath = join(repoRoot, ".loom", "devnet", "state.json");

function loom(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The suite must never run against a real owned devnet, and must never leave one.
function assertNoOwnedState() {
  if (existsSync(statePath)) {
    throw new Error(`refusing to run: an owned devnet state file exists at ${statePath}`);
  }
}

test("no arguments prints usage and exits zero", () => {
  assertNoOwnedState();
  const { code, stdout } = loom();
  assert.equal(code, 0);
  assert.match(stdout, /usage: loom devnet/);
});

test("an unknown top-level command is an input error", () => {
  assertNoOwnedState();
  const { code, stderr } = loom("frobnicate");
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
});

test("an unknown devnet subcommand is an input error", () => {
  assertNoOwnedState();
  const { code, stderr } = loom("devnet", "teleport");
  assert.equal(code, 2);
  assert.match(stderr, /unknown devnet command/);
});

test("down refuses to guess when no state was recorded", () => {
  assertNoOwnedState();
  const { code, stderr } = loom("devnet", "down");
  assert.equal(code, 2);
  assert.match(stderr, /no owned devnet state/);
  assert.equal(existsSync(statePath), false);
});

test("status reports not-running with no state", () => {
  assertNoOwnedState();
  const { code, stdout } = loom("devnet", "status", "--json");
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.running, false);
});

test("logs rejects an unknown component before touching disk", () => {
  assertNoOwnedState();
  const { code, stderr } = loom("devnet", "logs", "kernel");
  assert.equal(code, 2);
  assert.match(stderr, /unknown log component/);
});

test("the --json failure envelope is well-formed", () => {
  assertNoOwnedState();
  const { code, stdout } = loom("devnet", "down", "--json");
  assert.equal(code, 2);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /no owned devnet state/);
});

test.after(() => {
  // Defensive: never leave a stray empty state directory behind.
  const dir = join(repoRoot, ".loom");
  if (existsSync(dir) && !existsSync(statePath)) rmSync(dir, { recursive: true, force: true });
});
