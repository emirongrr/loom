import assert from "node:assert/strict";
import test from "node:test";
import { buildRecoveryLifecycle, RECOVERY_FLOW_MODES } from "../ui/recovery-lifecycle.mjs";

test("guardian recovery exposes the complete delayed lifecycle and both cancellation authorities", () => {
  const flow = buildRecoveryLifecycle("recovery");

  assert.deepEqual(flow.nodes.map(node => node.id), [
    "provision",
    "digest",
    "approve",
    "propose",
    "delay",
    "cancel-account",
    "cancel-guardians",
    "execute"
  ]);
  assert.equal(flow.nodes.find(node => node.id === "delay").summary.includes("3-day"), false);
  assert.match(flow.nodes.find(node => node.id === "delay").title, /3 days/u);
  assert.match(flow.nodes.find(node => node.id === "delay").title, /7-day/u);
  assert.match(flow.nodes.find(node => node.id === "cancel-account").invariant, /one fewer guardian/u);
  assert.match(flow.nodes.find(node => node.id === "cancel-guardians").invariant, /full current guardian threshold/u);
  assert.match(flow.nodes.find(node => node.id === "execute").state, /guardian root and threshold rotate/u);
  assert.equal(flow.edges.some(edge => edge.from === "delay" && edge.to === "execute"), true);
  assert.equal(flow.edges.filter(edge => edge.from === "delay" && edge.to.startsWith("cancel")).length, 2);
});

test("freeze remains a bounded veto and preserves only the exact recovery cancellation escape hatch", () => {
  const flow = buildRecoveryLifecycle("freeze", "freeze-block");

  assert.equal(flow.selected.id, "freeze-block");
  assert.match(flow.nodes.find(node => node.id === "freeze-write").title, /5-day/u);
  assert.match(flow.nodes.find(node => node.id === "freeze-block").invariant, /never becomes execution, spending, or recovery approval authority/u);
  assert.match(flow.nodes.find(node => node.id === "freeze-escape").invariant, /Target, selector, account argument, call type, and zero value/u);
  assert.match(flow.nodes.find(node => node.id === "freeze-expire").invariant, /cannot shorten an active guardian freeze/u);
});

test("unknown recovery modes fail closed to the primary recovery model", () => {
  const flow = buildRecoveryLifecycle("unknown", "missing");

  assert.equal(flow.mode, "recovery");
  assert.equal(flow.selected.id, RECOVERY_FLOW_MODES.recovery.nodes[0].id);
});
