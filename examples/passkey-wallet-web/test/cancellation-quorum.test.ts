import assert from "node:assert/strict";
import test from "node:test";
import { cancellationQuorum } from "../src/features/recovery/cancellationQuorum.ts";

// Reported twice from the running app, in two different screens that had each
// written the rule out by hand.
test("one guardian is never called \"1 guardians\"", () => {
  for (let threshold = 1; threshold <= 8; threshold += 1) {
    assert.doesNotMatch(cancellationQuorum(threshold).sentence, /\b1 guardians\b/);
  }
});

test("a threshold of one collapses to a single statement", () => {
  const quorum = cancellationQuorum(1);
  assert.equal(quorum.collapsed, true);
  assert.match(quorum.sentence, /1 guardian, with or without/);
});

// ADR-0023: the account is never sufficient alone, or a stolen key could block
// the guardians trying to take the account back.
test("the account route always still needs at least one guardian", () => {
  for (let threshold = 1; threshold <= 8; threshold += 1) {
    assert.ok(cancellationQuorum(threshold).withAccount >= 1);
  }
});

test("the guardian-only route asks for the full threshold", () => {
  assert.equal(cancellationQuorum(5).guardiansOnly, 5);
  assert.equal(cancellationQuorum(5).withAccount, 4);
});

test("plurals follow the count on both routes", () => {
  assert.match(cancellationQuorum(2).sentence, /plus 1 guardian, or 2 guardians/);
  assert.match(cancellationQuorum(3).sentence, /plus 2 guardians, or 3 guardians/);
});

test("a nonsensical threshold is floored to one rather than printed", () => {
  assert.equal(cancellationQuorum(0).guardiansOnly, 1);
  assert.equal(cancellationQuorum(-3).collapsed, true);
});
