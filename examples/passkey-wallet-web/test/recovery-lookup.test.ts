import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  classifyRecoveryLookup,
  executionBlockers,
  selectLocalInitData,
  verifyExecutionArguments,
  type PendingRecoveryRecord
} from "../src/features/recovery/recoveryLookup.ts";

const VALIDATOR = "0xd86B5531361f6382342f59700fF1B309919Eaf0a" as const;
const NEW_VALIDATOR = "0x2065fc45C630ec2CD284d2578EeE9915fF8220a0" as const;
const INIT_DATA = "0xdeadbeef" as const;

const record = (over: Partial<PendingRecoveryRecord> = {}): PendingRecoveryRecord => ({
  oldValidatorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }], [[VALIDATOR]])),
  newValidator: NEW_VALIDATOR,
  initDataHash: keccak256(INIT_DATA),
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

test("blockers name every reason, and name none when the call would be accepted", () => {
  const ready = classifyRecoveryLookup({ record: record(), liveConfigVersion: 1n, nowSeconds: 1500n });
  assert.deepEqual(executionBlockers({ lookup: ready, hasInitData: true }), []);

  const withoutInit = executionBlockers({ lookup: ready, hasInitData: false });
  assert.equal(withoutInit.length, 1);
  assert.match(withoutInit[0]!, /initialization data/);

  const stale = classifyRecoveryLookup({ record: record(), liveConfigVersion: 9n, nowSeconds: 1500n });
  assert.equal(executionBlockers({ lookup: stale, hasInitData: false }).length, 2, "both reasons are reported");

  assert.match(executionBlockers({ lookup: { kind: "none" }, hasInitData: true })[0]!, /No recovery is pending/);
});

test("execution arguments are checked against the stored hashes", () => {
  const stored = record();
  assert.deepEqual(
    verifyExecutionArguments({ record: stored, oldValidators: [VALIDATOR], initData: INIT_DATA }),
    { ok: true, problems: [] }
  );
});

// The whole point of holding init data off chain is that only its hash is
// public. A pasted value that does not hash to it is the one thing this can
// tell a user, so it must not pass.
test("init data that does not hash to the stored value is rejected", () => {
  const result = verifyExecutionArguments({ record: record(), oldValidators: [VALIDATOR], initData: "0xdeadbeee" });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /does not hash/);
});

test("a wrong validator set is rejected, and both problems can be reported at once", () => {
  const wrongSet = verifyExecutionArguments({ record: record(), oldValidators: [NEW_VALIDATOR], initData: INIT_DATA });
  assert.equal(wrongSet.ok, false);
  assert.match(wrongSet.problems.join(" "), /validator set/);

  const both = verifyExecutionArguments({ record: record(), oldValidators: [NEW_VALIDATOR], initData: "0x00" });
  assert.equal(both.problems.length, 2);
});

test("non-hex init data is rejected before it is hashed", () => {
  const result = verifyExecutionArguments({ record: record(), oldValidators: [VALIDATOR], initData: "0xzz" as `0x${string}` });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /not valid hex/);
});

// Address casing must not decide whether a recovery can be executed: the hash
// is over the checksummed bytes either way.
test("validator addresses compare by value, not by casing", () => {
  const result = verifyExecutionArguments({
    record: record(),
    oldValidators: [VALIDATOR.toLowerCase() as typeof VALIDATOR],
    initData: INIT_DATA
  });
  assert.equal(result.ok, true);
});

// Empty init data is a real case -- a recovery can be proposed with none -- and
// it must be distinguishable from "not supplied".
test("empty init data verifies when that is what was approved", () => {
  const stored = record({ initDataHash: keccak256("0x") });
  assert.equal(verifyExecutionArguments({ record: stored, oldValidators: [VALIDATOR], initData: "0x" }).ok, true);
  assert.equal(verifyExecutionArguments({ record: stored, oldValidators: [VALIDATOR], initData: INIT_DATA }).ok, false);
});

test("local execution data is chosen by hash, not by being present", () => {
  const stored = record();
  assert.equal(selectLocalInitData({ record: stored, candidates: [] }), null);
  assert.equal(selectLocalInitData({ record: stored, candidates: ["0xdeadbeee", "0x00"] }), null, "near misses are not accepted");
  assert.equal(selectLocalInitData({ record: stored, candidates: ["0xdeadbeee", INIT_DATA] }), INIT_DATA);
});

// A device can hold several drafts for the same account. Only the one the
// guardians approved may be used.
test("a stale draft for the same account is not mistaken for the live one", () => {
  const stale = "0xabcdef" as const;
  const stored = record();
  assert.notEqual(keccak256(stale), stored.initDataHash);
  assert.equal(selectLocalInitData({ record: stored, candidates: [stale] }), null);
});

test("malformed stored values are skipped rather than throwing", () => {
  assert.equal(
    selectLocalInitData({ record: record(), candidates: ["not-hex" as `0x${string}`, "0xzz" as `0x${string}`, INIT_DATA] }),
    INIT_DATA
  );
});
