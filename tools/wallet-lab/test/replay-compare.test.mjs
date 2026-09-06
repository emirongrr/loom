import assert from "node:assert/strict";
import test from "node:test";
import { assertReplayEquivalent } from "../replay-compare.mjs";

function artifact(overrides = {}) {
  return {
    status: "success",
    scenarioId: "scenario.v1",
    scenario: { seed: "deterministic-seed" },
    events: [
      { phase: "account-resolution", account: "0xaccount" },
      { phase: "bundler-submission", userOpHash: "0xuserop" }
    ],
    stateDiff: [{ name: "Nonce", before: "0", after: "1" }],
    invariants: [{ id: "hash", status: "pass", explanation: "matches" }],
    ...overrides
  };
}

test("replay equivalence ignores run-local timing but binds semantic evidence", () => {
  assert.doesNotThrow(() => assertReplayEquivalent(artifact({ runId: "first" }), artifact({ runId: "second" })));
  const changed = artifact({ events: [
    { phase: "account-resolution", account: "0xaccount" },
    { phase: "bundler-submission", userOpHash: "0xother" }
  ] });
  assert.throws(() => assertReplayEquivalent(artifact(), changed), /another UserOperation hash/u);
});

test("failed runs require a future deterministic fault declaration", () => {
  assert.throws(() => assertReplayEquivalent(artifact({ status: "error" }), artifact()), /only successful Phase 1 runs/u);
});

test("replay binds gas-payment direction while allowing live base-fee variance", () => {
  const first = artifact({ stateDiff: [{ name: "EntryPoint deposit", before: "100", after: "70", unit: "wei", explanation: "gas" }] });
  const second = artifact({ stateDiff: [{ name: "EntryPoint deposit", before: "100", after: "60", unit: "wei", explanation: "gas" }] });
  assert.doesNotThrow(() => assertReplayEquivalent(first, second));
  const unpaid = artifact({ stateDiff: [{ name: "EntryPoint deposit", before: "100", after: "100", unit: "wei", explanation: "gas" }] });
  assert.throws(() => assertReplayEquivalent(first, unpaid), /must decrease/u);
});
