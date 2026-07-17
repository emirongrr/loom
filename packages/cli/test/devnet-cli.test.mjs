import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { removeSync } from "../src/devnet.mjs";
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
  if (existsSync(dir) && !existsSync(statePath)) removeSync(dir);
});

// Teardown must be robust against the two states a crash can leave behind:
// recorded processes already dead, and recorded processes still alive. Both
// are exercised with real state files and (for the live case) a real child
// process this suite owns — no devnet required.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

function writeState(pids) {
  mkdirSync(join(repoRoot, ".loom", "devnet"), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({ startedAt: new Date().toISOString(), chainId: 31337, rpcUrl: "http://127.0.0.1:8545", bundlerUrl: "http://127.0.0.1:4337", pids, addresses: {} }, null, 2)}\n`
  );
}

test("down removes state even when the recorded processes are already dead", () => {
  assertNoOwnedState();
  // A child that has already exited: its pid is real but dead.
  const ghost = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
  assert.equal(ghost.status, 0);
  writeState({ anvil: ghost.pid ?? 99999, alto: 999999 });

  const { code } = loom("devnet", "down");
  assert.equal(code, 0, "down succeeds on dead pids");
  assert.equal(existsSync(statePath), false, "state file removed");
});

test("down terminates a live recorded process and removes state", async () => {
  assertNoOwnedState();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid, "test child started");
  try {
    writeState({ anvil: child.pid, alto: 999999 });

    const { code } = loom("devnet", "down");
    assert.equal(code, 0);
    assert.equal(existsSync(statePath), false, "state file removed");

    // The recorded process must actually be gone shortly after.
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      try {
        process.kill(child.pid, 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "recorded process was terminated by down");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});
