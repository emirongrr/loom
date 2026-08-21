import assert from "node:assert/strict";
import test from "node:test";
import { recoveryViewStage } from "../src/features/recovery/recoveryProgress.ts";

test("nothing done yet is the first step", () => {
  assert.equal(recoveryViewStage({}), "account-verification");
});

test("the passkey form being open is the second step", () => {
  assert.equal(recoveryViewStage({ showingPasskey: true }), "validator-provisioning");
});

// Reported from the running app: a recovery whose delay was already counting
// down showed "New passkey" as the current step, telling the reader to do
// something they had finished days earlier.
test("a proposal on chain outranks an open passkey form", () => {
  assert.equal(
    recoveryViewStage({ showingPasskey: true, pendingOnChain: true }),
    "delay-execution"
  );
});

test("a published validator moves past the passkey step", () => {
  assert.equal(
    recoveryViewStage({ showingPasskey: true, validatorPublished: true }),
    "guardian-approvals"
  );
});

test("a session collecting approvals is the third step", () => {
  assert.equal(recoveryViewStage({ sessionStage: "collecting" }), "guardian-approvals");
});

test("a session past approval is the fourth", () => {
  assert.equal(recoveryViewStage({ sessionStage: "delay-active" }), "delay-execution");
});

// Progress is a fact about the account, so no combination of weaker evidence
// can pull it back.
test("progress never moves backwards", () => {
  assert.equal(
    recoveryViewStage({ showingPasskey: true, sessionStage: "collecting", validatorPublished: true, pendingOnChain: true }),
    "delay-execution"
  );
});
