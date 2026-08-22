import assert from "node:assert/strict";
import test from "node:test";
import { GuardianRecoveryError } from "@loom/sdk/recovery";
import { describeDraftFailure, summarizeDraftFailures } from "../src/features/recovery/draftDiagnosis.ts";

test("a known repository message is repeated verbatim, so the cause is legible", () => {
  const failure = describeDraftFailure({
    stage: "decode", label: "Recovered wallet", error: new Error("recovery draft init data hash is invalid")
  });
  assert.equal(failure.stage, "decode");
  assert.equal(failure.reason, "recovery draft init data hash is invalid");
});

// The reason this is an allowlist and not a filter: a message that ever begins
// carrying data must not reach the screen because nobody updated a rule.
test("an unrecognised message is withheld, and only the error type is shown", () => {
  const failure = describeDraftFailure({
    stage: "derive", label: "Recovered wallet", error: new TypeError("0x04ab… secret key material")
  });
  assert.doesNotMatch(failure.reason, /secret/);
  assert.doesNotMatch(failure.reason, /0x04ab/);
  assert.match(failure.reason, /TypeError/);
  assert.match(failure.reason, /withheld/);
});

test("a guardian error contributes its code and its vetted message", () => {
  const failure = describeDraftFailure({
    stage: "derive",
    label: "Recovered wallet",
    error: new GuardianRecoveryError("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "internal detail")
  });
  assert.match(failure.reason, /UNSUPPORTED_RECOVERED_VALIDATOR_PATH/);
});

test("a mismatch carries no error at all and still reads as a cause", () => {
  const failure = describeDraftFailure({ stage: "mismatch", label: "Recovered wallet" });
  assert.equal(failure.reason, "unknown failure");
  assert.equal(failure.stage, "mismatch");
});

// A label is chosen by the user and could be long; it is theirs to see, but it
// should not be able to push the rest of the sentence off the screen.
test("a long label is truncated", () => {
  const failure = describeDraftFailure({ stage: "decode", label: "x".repeat(500) });
  assert.equal(failure.label.length, 80);
});

test("nothing failed means nothing is said", () => {
  assert.equal(summarizeDraftFailures([]), "");
});

test("the summary names each draft and how far it got", () => {
  const summary = summarizeDraftFailures([
    describeDraftFailure({ stage: "decode", label: "First", error: new Error("recovery draft is invalid") }),
    describeDraftFailure({ stage: "mismatch", label: "Second" })
  ]);
  assert.match(summary, /2 saved recovery drafts/);
  assert.match(summary, /First/);
  assert.match(summary, /could not be read/);
  assert.match(summary, /Second/);
  assert.match(summary, /does not match the validator it names/);
});

test("one failure does not read as plural", () => {
  const summary = summarizeDraftFailures([describeDraftFailure({ stage: "decode", label: "Only" })]);
  assert.match(summary, /1 saved recovery draft on this device/);
  assert.doesNotMatch(summary, /drafts/);
});
