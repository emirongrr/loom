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
  assert.deepEqual(classifyExistingPublications({ published: [] }), { kind: "none" });
});

test("one publication this device holds is simply the recovery in progress", () => {
  const result = classifyExistingPublications({
    published: [entry(FIRST, 11512004n)],
    restored: FIRST
  });
  assert.equal(result.kind, "resumable");
});

// The case that cost real gas: a publication exists, the draft that made it is
// gone, and the wallet offered a fresh passkey without saying so.
test("a publication this device cannot continue is reported, not hidden", () => {
  const result = classifyExistingPublications({ published: [entry(FIRST, 11512004n)] });
  assert.equal(result.kind, "orphaned");
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.match(result.message, /already published/);
  assert.match(result.message, /costs gas again/);
  assert.match(result.message, /only one recovery can ever be proposed/);
  assert.equal(result.resumable, undefined);
});

test("the exact addresses are named, so the warning can be checked against a explorer", () => {
  const result = classifyExistingPublications({ published: [entry(FIRST, 1n), entry(SECOND, 2n)] });
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
    restored: SECOND
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
    restored: FIRST
  });
  assert.equal(result.kind, "resumable");
});

test("publications are ordered by block, so the earliest reads first", () => {
  const result = classifyExistingPublications({ published: [entry(SECOND, 9n), entry(FIRST, 1n)] });
  if (result.kind !== "orphaned") throw new Error("unreachable");
  assert.equal(result.published[0]?.validator, FIRST);
});

test("the singular case does not read as plural", () => {
  const one = classifyExistingPublications({ published: [entry(FIRST, 1n)] });
  if (one.kind !== "orphaned") throw new Error("unreachable");
  assert.match(one.message, /1 recovery passkey were|1 recovery passkey was|1 recovery passkey /);
  assert.doesNotMatch(one.message, /passkeys/);
});
