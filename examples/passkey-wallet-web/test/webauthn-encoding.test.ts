import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesFromHex,
  derP256SignatureToRaw,
  equalBytes,
  hexFromBytes
} from "../src/services/webauthn/encoding.ts";

test("WebAuthn byte and hex conversion round-trips", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.deepEqual(bytesFromHex(hexFromBytes(bytes)), bytes);
  assert.throws(() => bytesFromHex("0x123" as `0x${string}`));
});

test("WebAuthn byte comparison rejects length and content differences", () => {
  assert.equal(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0])), false);
});

test("strict DER P-256 conversion pads r and s to two ABI words", () => {
  const raw = derP256SignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]));
  assert.equal(raw.length, 64);
  assert.equal(raw[31], 1);
  assert.equal(raw[63], 2);
  assert.throws(() => derP256SignatureToRaw(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])));
});
