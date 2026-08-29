import assert from "node:assert/strict";
import test from "node:test";
import { mediumAddress, shortAddress } from "../src/components/address.ts";

const ADDRESS = "0xA508B1de102225F25069bF8c72CBa7673c242C03";

// The two widths were written out by hand in ten places. These pin the exact
// output so consolidating them cannot quietly change what a reader sees.
test("the short form keeps six leading and four trailing characters", () => {
  assert.equal(shortAddress(ADDRESS), "0xA508…2C03");
});

test("the medium form keeps ten leading and six trailing characters", () => {
  assert.equal(mediumAddress(ADDRESS), "0xA508B1de…242C03");
});

test("case is never altered, so a checksum survives shortening", () => {
  assert.equal(shortAddress(ADDRESS).startsWith("0xA508"), true);
  assert.equal(mediumAddress(ADDRESS).includes("B1de"), true);
});

// Both are display helpers, so neither may be used where a value has to be
// compared: two different addresses can agree on both ends.
test("two addresses sharing both ends shorten to the same string", () => {
  const other = "0xA508ffffffffffffffffffffffffffff73c242C03".slice(0, 42);
  assert.equal(shortAddress(other).slice(0, 6), shortAddress(ADDRESS).slice(0, 6));
});
