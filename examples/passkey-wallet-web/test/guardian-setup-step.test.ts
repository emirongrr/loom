import assert from "node:assert/strict";
import test from "node:test";
import { guardianSetupStep } from "../src/features/security/guardianSetupStep.ts";

const step = (over: Partial<Parameters<typeof guardianSetupStep>[0]> = {}) => guardianSetupStep({
  pending: false, stage: "list", dirty: false, hasGuardians: true, awaitingInvitations: false, ...over
});

// The screen is a place you return to in order to add or remove someone. A
// person looking at a set they are not changing is not partway through
// anything, and an indicator that insists otherwise is still read as if it
// could say where they are.
test("a settled set is in no step at all", () => {
  const view = step();
  assert.equal(view.current, null);
  assert.equal(view.changing, false);
  assert.deepEqual([...view.done], []);
});

test("setting up for the first time leads with the steps", () => {
  const view = step({ hasGuardians: false });
  assert.equal(view.current, 1);
  assert.equal(view.changing, true);
});

test("an edited draft brings the steps back", () => {
  assert.equal(step({ dirty: true }).current, 1);
});

test("exactly one step is current whenever any is", () => {
  const states = [
    step({ hasGuardians: false }), step({ dirty: true }), step({ stage: "review", dirty: true }),
    step({ pending: true }), step({ awaitingInvitations: true })
  ];
  for (const view of states) {
    assert.notEqual(view.current, null);
    assert.ok(!view.done.includes(view.current!));
  }
});

test("reviewing comes after choosing and before the delay", () => {
  const view = step({ stage: "review", dirty: true });
  assert.equal(view.current, 2);
  assert.deepEqual([...view.done], [1]);
});

test("a change waiting out its delay is the waiting step", () => {
  const view = step({ pending: true, dirty: true });
  assert.equal(view.current, 3);
  assert.deepEqual([...view.done], [1, 2]);
});

// Inviting is the last step of a change that just landed, not a state an
// account sits in forever.
test("inviting is a step only while invitations are actually outstanding", () => {
  assert.equal(step({ awaitingInvitations: true }).current, 4);
  assert.deepEqual([...step({ awaitingInvitations: true }).done], [1, 2, 3]);
  assert.equal(step({ awaitingInvitations: false }).current, null);
});

test("a pending change outranks an outstanding invitation", () => {
  assert.equal(step({ pending: true, awaitingInvitations: true }).current, 3);
});
