import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlEncode,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  LoomError,
  parseP256Signature
} from "../dist/index.js";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const validator = "0x3333333333333333333333333333333333333333";

function hex32(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

test("raw 64-byte r||s parses and already-low s is untouched", () => {
  const raw = `0x${"01".padStart(64, "0")}${"02".padStart(64, "0")}`;
  const { r, s } = parseP256Signature(raw);
  assert.equal(r, hex32(1n));
  assert.equal(s, hex32(2n));
});

test("high-s signatures are normalized to low-s", () => {
  const highS = P256_N - 2n;
  const raw = `0x${"01".padStart(64, "0")}${highS.toString(16).padStart(64, "0")}`;
  assert.equal(parseP256Signature(raw).s, hex32(2n));
});

test("DER signatures parse, including leading-zero padding", () => {
  // r = 0x80... needs a 33-byte integer with a 0x00 prefix in DER.
  const r = 0x80n << 240n;
  const s = 2n;
  const rBytes = `00${r.toString(16).padStart(64, "0")}`;
  const der = `0x30${(2 + 33 + 2 + 1).toString(16).padStart(2, "0")}0221${rBytes}0201${s.toString(16).padStart(2, "0")}`;
  const parsed = parseP256Signature(der);
  assert.equal(parsed.r, hex32(r));
  assert.equal(parsed.s, hex32(s));
});

test("malformed and out-of-range signatures fail closed", () => {
  for (const bad of [
    "0x1234",
    `0x${"00".repeat(64)}`, // r = 0
    `0x${"01".padStart(64, "0")}${P256_N.toString(16)}`, // s = n
    `0x31${"00".repeat(69)}` // wrong sequence tag, DER-length input
  ]) {
    assert.throws(() => parseP256Signature(bad), error => error instanceof LoomError && error.code === "SIGNATURE_INVALID");
  }
});

test("the webauthn struct and validator envelope encode deterministically", () => {
  const webauthn = encodeWebAuthnSignature({
    authenticatorData: "0xaa",
    clientDataJSON: "0xbb",
    origin: "https://wallet.example",
    r: hex32(1n),
    s: hex32(2n)
  });
  // Same origin as explicit hex bytes must encode identically.
  const explicit = encodeWebAuthnSignature({
    authenticatorData: "0xaa",
    clientDataJSON: "0xbb",
    origin: `0x${Buffer.from("https://wallet.example", "utf8").toString("hex")}`,
    r: hex32(1n),
    s: hex32(2n)
  });
  assert.equal(webauthn, explicit);

  const envelope = encodeValidatorSignature(validator, webauthn);
  assert.ok(envelope.includes(validator.slice(2)));
  assert.notEqual(envelope, encodeValidatorSignature("0x4444444444444444444444444444444444444444", webauthn));
});

test("base64UrlEncode matches Node's base64url for 32-byte hashes", () => {
  const hash = `0x${"0f".repeat(32)}`;
  assert.equal(base64UrlEncode(hash), Buffer.from("0f".repeat(32), "hex").toString("base64url"));
  const odd = "0x01ff10";
  assert.equal(base64UrlEncode(odd), Buffer.from("01ff10", "hex").toString("base64url"));
});
