import assert from "node:assert/strict";
import test from "node:test";
import { reduceGuardianManagerState, type GuardianManagerState } from "../src/features/security/useGuardianManagerController.ts";

test("guardian manager view, operation and error state remain one controller state", () => {
  let state: GuardianManagerState = { view: "list", status: "idle", error: "" };
  state = reduceGuardianManagerState(state, { type: "VIEW", view: "review" });
  state = reduceGuardianManagerState(state, { type: "WORKING", working: true });
  state = reduceGuardianManagerState(state, { type: "ERROR", error: "Safe error" });
  assert.deepEqual(state, { view: "review", status: "working", error: "Safe error" });
  state = reduceGuardianManagerState(state, { type: "WORKING", working: false });
  assert.equal(state.status, "idle");
});
