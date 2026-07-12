import assert from "node:assert/strict";
import test from "node:test";
import {
  concatHex,
  fromHex,
  LoomError,
  packUint128Pair,
  sizeOfHex,
  sliceHex,
  toBeHex,
  unpackUint128Pair
} from "../dist/index.js";

test("toBeHex pads big-endian to a fixed width", () => {
  assert.equal(toBeHex(1n, 2), "0x0001");
  assert.equal(toBeHex(255, 1), "0xff");
  assert.equal(toBeHex(0n, 16), `0x${"00".repeat(16)}`);
});

test("toBeHex rejects overflow and negatives", () => {
  assert.throws(() => toBeHex(256n, 1), LoomError);
  assert.throws(() => toBeHex(-1n, 4), LoomError);
});

test("fromHex is the inverse of toBeHex", () => {
  assert.equal(fromHex(toBeHex(123456n, 8)), 123456n);
  assert.equal(fromHex("0x"), 0n);
});

test("concatHex and sizeOfHex agree on byte length", () => {
  const joined = concatHex("0xdead", "0xbeef");
  assert.equal(joined, "0xdeadbeef");
  assert.equal(sizeOfHex(joined), 4);
});

test("sliceHex extracts byte ranges", () => {
  assert.equal(sliceHex("0xdeadbeef", 0, 2), "0xdead");
  assert.equal(sliceHex("0xdeadbeef", 2), "0xbeef");
});

test("uint128 pair packing round-trips high and low words", () => {
  const word = packUint128Pair(7n, 9n);
  assert.equal(sizeOfHex(word), 32);
  assert.deepEqual(unpackUint128Pair(word), [7n, 9n]);
});
