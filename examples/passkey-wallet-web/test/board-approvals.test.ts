import assert from "node:assert/strict";
import test from "node:test";
import { mergeApprovals } from "../src/features/recovery/boardApprovals.ts";

/**
 * How many guardian seats are filled, counting each guardian once however
 * their approval arrived. The page uses the same rule to decide whether the
 * proposal can be offered.
 */
const seatsFilled = (input: {
  readonly responses: readonly { readonly guardianLeaf: string }[];
  readonly published: readonly { readonly guardianLeaf: string }[];
}): number => new Set([
  ...input.responses.map(entry => entry.guardianLeaf.toLowerCase()),
  ...input.published.map(entry => entry.guardianLeaf.toLowerCase())
]).size;

const leafA = `0x${"a1".repeat(32)}` as const;
const leafB = `0x${"b2".repeat(32)}` as const;

const tuple = (mark: string) => ({
  verifier: `0x${mark.repeat(20)}`,
  keyCommitment: `0x${mark.repeat(32)}`,
  salt: `0x${mark.repeat(32)}`,
  signature: `0x${mark}`,
  proof: []
}) as never;

test("approvals from both routes are counted, once each", () => {
  const merged = mergeApprovals({
    collected: [{ leaf: leafA, approval: tuple("11") }],
    published: [{ guardianLeaf: leafB, approval: tuple("22"), confirmed: true }]
  });
  assert.equal(merged.length, 2);
});

// A guardian who published on chain and also sent their response privately is
// still one guardian. proposeRecovery would refuse the duplicate -- approvals
// must arrive in strictly increasing leaf order -- but only after the gas.
test("one guardian using both routes is still one approval", () => {
  const merged = mergeApprovals({
    collected: [{ leaf: leafA, approval: tuple("11") }],
    published: [{ guardianLeaf: leafA, approval: tuple("22"), confirmed: true }]
  });
  assert.equal(merged.length, 1);
});

// The privately delivered one is the one the device actually verified against
// live state, so it wins a tie.
test("a response this device verified outranks the same guardian's published copy", () => {
  const mine = tuple("11");
  const merged = mergeApprovals({
    collected: [{ leaf: leafA, approval: mine }],
    published: [{ guardianLeaf: leafA, approval: tuple("22"), confirmed: true }]
  });
  assert.equal(merged[0], mine);
});

test("leaves match by value, not by casing", () => {
  const merged = mergeApprovals({
    collected: [{ leaf: leafA.toUpperCase() as never, approval: tuple("11") }],
    published: [{ guardianLeaf: leafA, approval: tuple("22"), confirmed: true }]
  });
  assert.equal(merged.length, 1);
});

test("nothing published leaves the collected set untouched", () => {
  const merged = mergeApprovals({
    collected: [{ leaf: leafA, approval: tuple("11") }, { leaf: leafB, approval: tuple("22") }],
    published: []
  });
  assert.equal(merged.length, 2);
});

// The board alone is enough: a recovery whose guardians all published needs no
// device to have received anything.
test("a proposal can be assembled entirely from the board", () => {
  const merged = mergeApprovals({
    collected: [],
    published: [
      { guardianLeaf: leafA, approval: tuple("11"), confirmed: true },
      { guardianLeaf: leafB, approval: tuple("22"), confirmed: false }
    ]
  });
  assert.equal(merged.length, 2);
});

// Reported from the running app: two approvals were on the board, the proposal
// already knew how to use them, and the step that reveals it counted only the
// ones pasted in. The recovery was complete and looked stuck.
test("approvals from the board fill guardian seats", () => {
  assert.equal(seatsFilled({ responses: [], published: [{ guardianLeaf: leafA }, { guardianLeaf: leafB }] }), 2);
});

test("a guardian who used both routes fills one seat, not two", () => {
  assert.equal(seatsFilled({ responses: [{ guardianLeaf: leafA }], published: [{ guardianLeaf: leafA }] }), 1);
});

test("seats count across routes", () => {
  assert.equal(seatsFilled({ responses: [{ guardianLeaf: leafA }], published: [{ guardianLeaf: leafB }] }), 2);
});
