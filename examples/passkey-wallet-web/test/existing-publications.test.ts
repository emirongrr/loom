import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExistingPublications,
  type PublishedRecoveryValidator
} from "../src/features/recovery/existingPublications.ts";

const FIRST = "0xD79E07D569fD8F5b526a606e5B1d870D55e3C62d" as const;
const SECOND = "0xB028a14763eC7D2AD533b30100875Fa59Ecb03Bc" as const;

const entry = (validator: string, blockNumber: bigint): PublishedRecoveryValidator => ({
  validator: validator as `0x${string}`,
  initDataHash: `0x${"11".repeat(32)}`,
  blockNumber
});

test("an account with nothing published needs no warning", () => {
  assert.deepEqual(classifyExistingPublications({ published: [], complete: true }), { kind: "none" });
});

// The defect this file exists to prevent: the scan reports whether it saw the
// whole chain, and a caller that finds nothing in a bounded window must not
// present that as an empty history. Reported as "none", the check would look
// like it ran when it only ran partway.
test("finding nothing in a bounded scan is reported as unsettled, not as none", () => {
  const result = classifyExistingPublications({
    published: [], complete: false, scannedFromBlock: 11_164_451n
  });
  assert.equal(result.kind, "unknown");
  if (result.kind !== "unknown") throw new Error("unreachable");
  assert.match(result.message, /11164451/);
  assert.match(result.message, /not proof/);
});

test("one publication this device holds is simply the recovery in progress", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)],
    restored: FIRST,
    complete: true
  });
  assert.equal(result.kind, "resumable");
});

// The same single publication, but the scan never reached the start of the
// chain: an earlier one may sit below the window, so "this is your recovery,
// nothing else exists" is more than the scan established.
test("a bounded scan does not promise the one publication it found is the only one", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)],
    restored: FIRST,
    complete: false,
    scannedFromBlock: 11_164_451n
  });
  assert.equal(result.kind, "orphaned");
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.equal(result.resumable, FIRST);
  assert.match(result.message, /cannot be ruled out/);
  assert.doesNotMatch(result.message, /abandoned/i);
});

// The case that cost real gas: a publication exists, the draft that made it is
// gone, and the wallet offered a fresh passkey without saying so.
test("a publication this device cannot continue is reported, not hidden", () => {
  const result = classifyExistingPublications({ published: [entry(FIRST, 11512004n)], complete: true });
  assert.equal(result.kind, "orphaned");
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /already published/);
  assert.match(result.message, /costs gas again/);
  assert.match(result.message, /only one recovery can ever be proposed/);
  assert.equal(result.resumable, undefined);
});

// The report that prompted this: the device did hold drafts, they simply would
// not open, and the interface said it held none -- sending the reader to pay
// for another passkey to work around a draft problem.
test("unreadable drafts are not reported as an empty device", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)], complete: true, heldDrafts: 2
  });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /holds 2 saved recovery drafts/);
  assert.match(result.message, /unreadable/);
  assert.doesNotMatch(result.message, /holds none of them/);
});

test("one unreadable draft does not read as plural", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 1n)], complete: true, heldDrafts: 1
  });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /holds 1 saved recovery draft\b/);
  assert.doesNotMatch(result.message, /1 saved recovery drafts/);
});

test("the exact addresses are named, so the warning can be checked against a explorer", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 1n), entry(SECOND, 2n)], complete: true
  });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /0xD79E07D5/);
  assert.match(result.message, /0xB028a147/);
});

// Two publications where one is resumable: the user can still finish, but the
// other is dead and the gas is gone. Saying only "you can continue" would hide
// that.
test("a resumable publication alongside abandoned ones reports both facts", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 1n), entry(SECOND, 2n)],
    restored: SECOND,
    complete: true
  });
  assert.equal(result.kind, "orphaned");
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.equal(result.resumable, SECOND);
  assert.match(result.message, /Only the one this device holds can be proposed/);
  assert.match(result.message, /0xD79E07D5/);
  assert.doesNotMatch(result.message, /0xB028a147/, "the resumable one is not listed as abandoned");
});

test("addresses match by value, not by casing", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST.toLowerCase(), 1n)],
    restored: FIRST,
    complete: true
  });
  assert.equal(result.kind, "resumable");
});

test("publications are ordered by block, so the earliest reads first", () => {
  const result = classifyExistingPublications({
    published: [entry(SECOND, 9n), entry(FIRST, 1n)], complete: true
  });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.equal(result.published[0]?.validator, FIRST);
});

test("the singular case does not read as plural", () => {
  const one = classifyExistingPublications({ published: [entry(FIRST, 1n)], complete: true });
  if (one.kind !== "orphaned") throw new Error("unreachable");
  // This alternation used to accept "were" too, so the app shipped
  // "1 recovery passkey were already published" and the test stayed green.
  assert.match(one.message, /\b1 recovery passkey was already published\b/);
  assert.doesNotMatch(one.message, /passkeys/);
  assert.doesNotMatch(one.message, /passkey were/);
});

// A bounded scan appends its reach to the warning rather than replacing it: the
// abandoned publications are still real, there may simply be more.
test("a bounded scan that found orphans still names them, and says how far it looked", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)], complete: false, scannedFromBlock: 11_164_451n
  });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /0xD79E07D5/);
  assert.match(result.message, /reached back only to block 11164451/);
});

// The measured failure this endpoint actually exhibits: the identical
// eth_getLogs call over one 45,000-block range returned one log 14 times out of
// 20 and two logs the other 6, with no error either way. A classification that
// treats a single read as settled fact is a coin flip.
test("endpoints that disagreed cannot support a settled answer", () => {
  const found = classifyExistingPublications({
    published: [entry(FIRST, 11512004n), entry(SECOND, 11512033n)],
    complete: true,
    consistent: false
  });
  if (found.kind !== "orphaned") throw new Error("unreachable");
  assert.match(found.message, /union of both/);
  assert.match(found.message, /explorer/);
});

test("a disagreement turns an empty result into unsettled, never into none", () => {
  const empty = classifyExistingPublications({ published: [], complete: true, consistent: false });
  assert.equal(empty.kind, "unknown");
});

test("one publication this device holds is not called settled when reads disagreed", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)], restored: FIRST, complete: true, consistent: false
  });
  assert.equal(result.kind, "orphaned");
});
