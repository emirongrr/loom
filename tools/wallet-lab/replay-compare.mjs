import assert from "node:assert/strict";

function eventValue(artifact, phase, field) {
  return artifact.events.find(event => event.phase === phase)?.[field];
}

function replayState(diff) {
  return diff.map(item => {
    if (item.name !== "EntryPoint deposit") return item;
    const before = BigInt(item.before);
    const after = BigInt(item.after);
    assert.ok(before > after, "EntryPoint deposit must decrease when the account pays gas");
    return {
      name: item.name,
      direction: "decreased",
      positiveGasPaid: before - after > 0n,
      unit: item.unit,
      explanation: item.explanation
    };
  });
}

export function assertReplayEquivalent(source, replay) {
  assert.equal(source.status, "success", "only successful Phase 1 runs are replayable until deterministic fault declarations land");
  assert.equal(replay.status, "success", "replay did not complete successfully");
  assert.equal(replay.scenarioId, source.scenarioId, "replay scenario changed");
  assert.equal(replay.scenario.seed, source.scenario.seed, "replay seed changed");
  assert.equal(eventValue(replay, "account-resolution", "account"), eventValue(source, "account-resolution", "account"), "replay derived another account");
  assert.equal(eventValue(replay, "bundler-submission", "userOpHash"), eventValue(source, "bundler-submission", "userOpHash"), "replay produced another UserOperation hash");
  // Base fee and bundler estimates are deliberately live protocol inputs, so
  // exact gas expenditure is not deterministic. The security property is that
  // the account paid a positive amount; every authorized value, nonce, target
  // state, and code identity remains byte-for-byte replay-bound.
  assert.deepEqual(replayState(replay.stateDiff), replayState(source.stateDiff), "replay semantic state diff changed");
  assert.deepEqual(replay.invariants, source.invariants, "replay invariant results changed");
}
