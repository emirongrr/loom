import assert from "node:assert/strict";
import test from "node:test";
import { boardSupportsCancellation, codeSupports, selectorOf } from "../src/features/guardians/boardCapabilities.ts";

// The board deployed to Sepolia before `publishCancellation` existed. Calling
// it reverted on selector dispatch, and all the person saw was the bundler
// refusing to estimate gas -- an error about gas, for a problem that has
// nothing to do with gas.
test("a board without the function is reported as unable to take cancellations", () => {
  const approvalOnly = `0x6080${selectorOf("publishApproval").slice(2)}6000`;
  assert.equal(boardSupportsCancellation(approvalOnly), false);
});

test("a board carrying the selector is reported as able", () => {
  const withBoth = `0x6080${selectorOf("publishApproval").slice(2)}${selectorOf("publishCancellation").slice(2)}`;
  assert.equal(boardSupportsCancellation(withBoth), true);
});

// An address with no contract cannot accept anything, and must not be treated
// as though the check simply failed.
test("an address with no code takes nothing", () => {
  assert.equal(boardSupportsCancellation("0x"), false);
  assert.equal(boardSupportsCancellation(undefined), false);
});

test("the selector comparison ignores casing", () => {
  const selector = selectorOf("publishCancellation");
  assert.equal(codeSupports(`0x6080${selector.slice(2).toUpperCase()}`, selector), true);
});

// Guards the two selectors against silently swapping places.
test("the two publication selectors are distinct", () => {
  assert.notEqual(selectorOf("publishCancellation"), selectorOf("publishApproval"));
  assert.match(selectorOf("publishCancellation"), /^0x[0-9a-f]{8}$/);
});
