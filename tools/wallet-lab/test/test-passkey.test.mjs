import assert from "node:assert/strict";
import test from "node:test";
import { deterministicTestPasskey } from "../test-passkey.mjs";

test("test passkey identity is stable for a seed and isolated across seeds", () => {
  const first = deterministicTestPasskey("scenario-seed-one");
  const replay = deterministicTestPasskey("scenario-seed-one");
  const other = deterministicTestPasskey("scenario-seed-two");
  assert.equal(first.credentialId, replay.credentialId);
  assert.deepEqual(first.publicKey, replay.publicKey);
  assert.notEqual(first.credentialId, other.credentialId);
  assert.notDeepEqual(first.publicKey, other.publicKey);
  assert.equal(JSON.stringify(first.privateKey), "{}");
  assert.equal(JSON.stringify(first).includes('"d"'), false);
});

test("test passkey refuses ambiguous short seeds", () => {
  assert.throws(() => deterministicTestPasskey("short"), /seed is too short/u);
});
