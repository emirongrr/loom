import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  classifyRecoveryLookup,
  executionBlockers,
  verifyExecutionArguments,
  type PendingRecoveryRecord
} from "../src/features/recovery/recoveryLookup.ts";

const VALIDATOR = "0xd86B5531361f6382342f59700fF1B309919Eaf0a" as const;
const NEW_VALIDATOR = "0x2065fc45C630ec2CD284d2578EeE9915fF8220a0" as const;

const record = (over: Partial<PendingRecoveryRecord> = {}): PendingRecoveryRecord => ({
  oldValidatorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }], [[VALIDATOR]])),
  newValidator: NEW_VALIDATOR,
  initDataHash: keccak256("0xdeadbeef"),
  newGuardianRoot: keccak256("0x01"),
  newGuardianThreshold: 2,
  readyAt: 1000n,
  expiresAt: 2000n,
  configVersion: 1n,
  nonce: 0n,
  ...over
});

test("an empty record reads as no recovery, and so does a zero readyAt", () => {
  assert.equal(classifyRecoveryLookup({ record: null, liveConfigVersion: 1n, nowSeconds: 500n }).kind, "none");
  assert.equal(
    classifyRecoveryLookup({ record: record({ readyAt: 0n }), liveConfigVersion: 1n, nowSeconds: 500n }).kind,
    "none"
  );
});

test("the delay, the window, and the close of the window are each reported", () => {
  const args = { record: record(), liveConfigVersion: 1n };
  assert.equal(classifyRecoveryLookup({ ...args, nowSeconds: 999n }).kind, "delay-active");
  assert.equal(classifyRecoveryLookup({ ...args, nowSeconds: 1000n }).kind, "ready", "readyAt itself is executable");
  assert.equal(classifyRecoveryLookup({ ...args, nowSeconds: 2000n }).kind, "ready", "expiresAt itself is executable");
  assert.equal(classifyRecoveryLookup({ ...args, nowSeconds: 2001n }).kind, "expired");
});

// The account moved on after approval, so the manager will refuse however good
// the timing looks. Calling that "ready" would send someone to buy gas for a
// call that cannot succeed.
test("a configuration change outranks timing, even inside the window", () => {
  const lookup = classifyRecoveryLookup({ record: record(), liveConfigVersion: 2n, nowSeconds: 1500n });
  assert.equal(lookup.kind, "stale-config");
});

test("the countdowns are reported from the caller's clock", () => {
  const lookup = classifyRecoveryLookup({ record: record(), liveConfigVersion: 1n, nowSeconds: 1500n });
  assert.equal(lookup.kind, "ready");
  if (lookup.kind === "none") throw new Error("unreachable");
  assert.equal(lookup.secondsUntilReady, -500);
  assert.equal(lookup.secondsUntilExpiry, 500);
});

// Execution needs no initializer any more, so a matured recovery has nothing
// left blocking it. That is the whole point of ADR-0025.
test("a matured recovery has no blockers at all", () => {
  const ready = classifyRecoveryLookup({ record: record(), liveConfigVersion: 1n, nowSeconds: 1500n });
  assert.deepEqual(executionBlockers({ lookup: ready }), []);

  const stale = classifyRecoveryLookup({ record: record(), liveConfigVersion: 9n, nowSeconds: 1500n });
  assert.equal(executionBlockers({ lookup: stale }).length, 1);
  assert.match(executionBlockers({ lookup: stale })[0]!, /configuration changed/);

  const waiting = classifyRecoveryLookup({ record: record(), liveConfigVersion: 1n, nowSeconds: 500n });
  assert.match(executionBlockers({ lookup: waiting })[0]!, /delay has not finished/);

  assert.match(executionBlockers({ lookup: { kind: "none" } })[0]!, /No recovery is pending/);
});

test("the validator set is checked against the stored hash", () => {
  assert.deepEqual(
    verifyExecutionArguments({ record: record(), oldValidators: [VALIDATOR] }),
    { ok: true, problems: [] }
  );
});

test("a validator set that does not match what was approved is rejected", () => {
  const wrong = verifyExecutionArguments({ record: record(), oldValidators: [NEW_VALIDATOR] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems.join(" "), /validator set/);
});

// Address casing must not decide whether a recovery can be executed: the hash
// is over the checksummed bytes either way.
test("validator addresses compare by value, not by casing", () => {
  const result = verifyExecutionArguments({
    record: record(),
    oldValidators: [VALIDATOR.toLowerCase() as typeof VALIDATOR]
  });
  assert.equal(result.ok, true);
});
