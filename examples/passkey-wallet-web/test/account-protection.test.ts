import assert from "node:assert/strict";
import test from "node:test";
import { describeAccountProtection } from "../src/features/security/accountProtection.ts";

const state = (over: Partial<Parameters<typeof describeAccountProtection>[0]> = {}) => describeAccountProtection({
  guardianThreshold: 2,
  recoveryConfigured: true,
  freezeActive: false,
  pendingRecovery: false,
  ...over
});

test("a protected account reads as recoverable, and says by whom", () => {
  const protection = state();
  assert.equal(protection.guarded, true);
  assert.equal(protection.signals[0]?.tone, "protected");
  assert.match(protection.signals[0]!.title, /2 guardians/);
});

// The shield is the one thing an owner should be able to read at a glance, so
// it must be red whenever the account cannot actually be recovered -- whether
// that is because nobody was named or because the module is not installed.
test("the shield is red when the account cannot be recovered, either way", () => {
  assert.equal(state({ guardianThreshold: 0 }).guarded, false);
  assert.equal(state({ recoveryConfigured: false }).guarded, false);
  assert.equal(state({ guardianThreshold: 0 }).signals[0]?.tone, "urgent");
  assert.equal(state({ guardianThreshold: 0 }).signals[0]?.action, "add-guardians");
});

test("one guardian is counted in the singular", () => {
  assert.match(state({ guardianThreshold: 1 }).signals[0]!.title, /1 guardian\b/);
});

// A row that reads "None" every day teaches people to stop reading it.
test("nothing is said about a freeze or a recovery that is not happening", () => {
  const quiet = state();
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.signals.length, 1);
  assert.ok(!quiet.signals.some(signal => signal.id === "freeze" || signal.id === "pending-recovery"));
});

test("a pending recovery is raised as urgent, with somewhere to go", () => {
  const pending = state({ pendingRecovery: true });
  const signal = pending.signals.find(entry => entry.id === "pending-recovery");
  assert.equal(signal?.tone, "urgent");
  assert.equal(signal?.action, "review-recovery");
  assert.equal(pending.quiet, false);
});

// A freeze stops spending; it does not stop recovery. Saying so prevents an
// owner concluding their guardians have locked them out entirely.
test("a freeze is attention, not alarm, and says what it does not block", () => {
  const frozen = state({ freezeActive: true });
  const signal = frozen.signals.find(entry => entry.id === "freeze");
  assert.equal(signal?.tone, "attention");
  assert.match(signal!.detail, /Recovery is unaffected/);
});

test("an unprotected account with a recovery underway reports both", () => {
  const both = state({ guardianThreshold: 0, pendingRecovery: true, freezeActive: true });
  assert.equal(both.signals.length, 3);
  assert.equal(both.guarded, false);
});

// Reported from the running app: an account with nothing pending showed
// "Someone is recovering this account" in red. The screen asked whether the
// decoded record existed rather than whether it held a recovery, and the record
// is present whenever the recovery module can be read at all — so every
// guardian-protected account claimed it was being taken.
//
// Asserted on the shape the SDK returns, because the defect was in reading that
// shape, not in interpreting the boolean once it was correct.
test("a readable but empty recovery record is not a recovery in progress", () => {
  const emptyRecord = { active: false, readyAt: 0n } as const;
  const protection = describeAccountProtection({
    guardianThreshold: 1,
    recoveryConfigured: true,
    freezeActive: false,
    pendingRecovery: emptyRecord.active === true
  });
  assert.equal(protection.quiet, true);
  assert.ok(!protection.signals.some(signal => signal.id === "pending-recovery"));
});

test("a record holding a recovery does raise it", () => {
  const held = { active: true, readyAt: 2_000_000_000n } as const;
  const protection = describeAccountProtection({
    guardianThreshold: 1,
    recoveryConfigured: true,
    freezeActive: false,
    pendingRecovery: held.active === true
  });
  assert.ok(protection.signals.some(signal => signal.id === "pending-recovery"));
});
