import assert from "node:assert/strict";
import test from "node:test";
import { GuardianRecoveryError } from "@loom/sdk/recovery";
import { announceFailure, safeRecoveryMessage } from "../src/features/recovery/recoveryMessages.ts";
import { shortStage } from "../src/features/recovery/recoveryStage.ts";

// A recovery error can carry chain state, guardian material, and the contents
// of a request. The collapse below is a boundary, not a fallback, so these pin
// that an unknown error never reaches the screen with its own words.
test("an arbitrary error is collapsed to one sentence that names nothing", () => {
  const message = safeRecoveryMessage(new Error("guardian leaf 0xdeadbeef rejected for account 0xabc"));
  assert.equal(message.includes("0xdeadbeef"), false);
  assert.equal(message.includes("0xabc"), false);
  assert.match(message, /account, network, and RPC/u);
});

test("a thrown string, object, or null is collapsed the same way", () => {
  const collapsed = safeRecoveryMessage(null);
  for (const value of ["boom", { secret: "0xdeadbeef" }, undefined, 42]) {
    assert.equal(safeRecoveryMessage(value), collapsed);
  }
});

test("an error this repository wrote keeps its own safe message", () => {
  const error = new GuardianRecoveryError("RECOVERY_NOT_CONFIGURED", "deployment has no recovery manager");
  assert.equal(safeRecoveryMessage(error), error.safeMessage);
});

// Announcing is the deliberate exception: every message on that path is written
// here or by the reader's own wallet, and collapsing them hid the one thing
// that would let the reader fix it.
test("an announcement failure keeps the code and the reason", () => {
  const error = new GuardianRecoveryError("RECOVERY_NOT_CONFIGURED", "deployment has no recovery manager");
  assert.match(announceFailure(error), /RECOVERY_NOT_CONFIGURED/u);
});

test("an announcement failure is truncated rather than allowed to run on", () => {
  assert.equal(announceFailure(new Error("x".repeat(5000))).length, 400);
});

test("an announcement failure with nothing to say still says something safe", () => {
  assert.equal(announceFailure(new Error("")), safeRecoveryMessage(new Error("")));
});

// A stage with no label would render an empty badge, which is the worst way to
// learn a state exists.
test("every recovery stage has a label", () => {
  const stages = ["request-created", "collecting", "ready-to-propose", "delay-active",
    "ready-to-execute", "completed", "cancelled", "expired", "blocked"] as const;
  for (const stage of stages) {
    assert.equal(typeof shortStage(stage), "string");
    assert.equal(shortStage(stage).length > 0, true, `${stage} has no label`);
  }
});
