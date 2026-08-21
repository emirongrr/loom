import assert from "node:assert/strict";
import test from "node:test";
import { mergeApprovals } from "../src/features/recovery/boardApprovals.ts";

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
