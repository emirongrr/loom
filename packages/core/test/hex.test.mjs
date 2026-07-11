import assert from "node:assert/strict";
import test from "node:test";
import { assertAddress, equalHex, isAddress, isHex, LoomError } from "../dist/index.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

test("isHex accepts 0x-prefixed hex and rejects others", () => {
  assert.equal(isHex("0x"), true);
  assert.equal(isHex("0xabc123"), true);
  assert.equal(isHex("0xGG"), false);
  assert.equal(isHex("abc"), false);
  assert.equal(isHex(123), false);
});

test("isAddress requires exactly 20 bytes", () => {
  assert.equal(isAddress(ADDRESS), true);
  assert.equal(isAddress("0x1234"), false);
  assert.equal(isAddress(`${ADDRESS}00`), false);
});

test("assertAddress returns valid input and throws a LoomError otherwise", () => {
  assert.equal(assertAddress(ADDRESS), ADDRESS);
  try {
    assertAddress("0xnope");
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof LoomError);
    assert.equal(error.code, "CONFIG_INVALID");
    assert.equal(error.safeMessage, "invalid address");
  }
});

test("equalHex compares case-insensitively and rejects non-hex", () => {
  assert.equal(equalHex("0xABCDEF", "0xabcdef"), true);
  assert.equal(equalHex(ADDRESS, ADDRESS.toUpperCase().replace("0X", "0x")), true);
  assert.equal(equalHex("0xabc", "0xabd"), false);
  assert.equal(equalHex("nope", "0xabc"), false);
});
