import assert from "node:assert/strict";
import test from "node:test";
import { recoverySessionView, seatsRemaining } from "../src/features/recovery/recoverySessionView.ts";

const view = (over: Partial<Parameters<typeof recoverySessionView>[0]> = {}) => recoverySessionView({
  stage: "collecting",
  seatsFilled: 0,
  threshold: 2,
  hasProposalTransaction: false,
  hasExecutionTransaction: false,
  ...over
});

test("while collecting, both ways of receiving an approval are offered", () => {
  const panels = view().panels;
  assert.ok(panels.includes("collect-from-chain"));
  assert.ok(panels.includes("import-response"));
  assert.equal(view().primary, "collect-approvals");
});

// The threshold can be reached by a response this device recorded or by one
// read from the board. Both must reveal the proposal step; only the first did
// before, and a recovery that was complete looked stuck.
test("the proposal step appears once the seats are filled, whichever route filled them", () => {
  assert.ok(view({ seatsFilled: 2 }).panels.includes("threshold-reached"));
  assert.ok(view({ stage: "ready-to-propose" }).panels.includes("threshold-reached"));
  assert.equal(view({ seatsFilled: 2 }).primary, "propose");
});

test("a partial set does not offer to propose", () => {
  assert.equal(view({ seatsFilled: 1 }).thresholdReached, false);
  assert.ok(!view({ seatsFilled: 1 }).panels.includes("threshold-reached"));
  assert.equal(seatsRemaining(view({ seatsFilled: 1 })), 1);
});

// Handing the request out after the threshold is met asks guardians for
// approvals nobody needs, and makes the recovery known more widely for nothing.
test("the request stops being handed out once the session has moved on", () => {
  assert.ok(view().panels.includes("send-to-guardians"));
  assert.ok(!view({ stage: "delay-active" }).panels.includes("send-to-guardians"));
  assert.ok(!view({ stage: "ready-to-execute" }).panels.includes("send-to-guardians"));
});

test("a proposed recovery shows its receipt and offers to check readiness", () => {
  const proposed = view({ stage: "delay-active", hasProposalTransaction: true });
  assert.deepEqual([...proposed.panels], ["proposal-receipt", "check-readiness"]);
  assert.equal(proposed.primary, "wait");
});

test("an executable recovery asks to be executed", () => {
  const ready = view({ stage: "ready-to-execute", hasProposalTransaction: true });
  assert.ok(ready.panels.includes("executable"));
  assert.equal(ready.primary, "execute");
});

test("once executed, the remaining act is keeping the recovered wallet", () => {
  const done = view({ stage: "completed", hasProposalTransaction: true, hasExecutionTransaction: true });
  assert.ok(done.panels.includes("execution-receipt"));
  assert.equal(done.primary, "save-recovered-wallet");
});

// A session the chain has already settled asks for nothing. Offering an action
// there would be offering one that can only be refused.
test("a cancelled, expired, or blocked session offers no action", () => {
  for (const stage of ["cancelled", "expired", "blocked"] as const) {
    assert.equal(view({ stage }).primary, "none");
    assert.deepEqual([...view({ stage }).panels], []);
  }
});

test("counts are floored rather than rendered as nonsense", () => {
  assert.equal(view({ threshold: 0, seatsFilled: -2 }).threshold, 1);
  assert.equal(view({ threshold: 0, seatsFilled: -2 }).seatsFilled, 0);
});
