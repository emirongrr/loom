import { encodeAbiParameters, stringToHex } from "viem";
import { fromHex, sizeOfHex, sliceHex, toBeHex } from "./bytes.js";
import { LoomError } from "./errors.js";
import { assertAddress, isHex } from "./hex.js";
import type { Address, Hex } from "./hex.js";

// P-256 group order and its half, mirroring the bounds WebAuthnP256 enforces
// on-chain. Signatures are normalized to low-s so a compliant authenticator's
// high-s output still verifies.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;

/** The exact struct `P256Validator` decodes from a validator signature. */
export interface WebAuthnSignatureFields {
  authenticatorData: Hex;
  clientDataJSON: Hex;
  /** The exact origin — a UTF-8 string or its hex bytes. */
  origin: string | Hex;
  r: Hex;
  s: Hex;
}

function originBytes(origin: string | Hex): Hex {
  return isHex(origin) ? origin : stringToHex(origin);
}

/**
 * ABI-encode the on-chain `WebAuthnSignature` struct
 * (`bytes authenticatorData, bytes clientDataJSON, bytes origin, bytes32 r, bytes32 s`)
 * exactly as `abi.decode(signature, (WebAuthnSignature))` expects it.
 */
export function encodeWebAuthnSignature(fields: WebAuthnSignatureFields): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "bytes" },
          { name: "origin", type: "bytes" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" }
        ]
      }
    ],
    [
      {
        authenticatorData: fields.authenticatorData,
        clientDataJSON: fields.clientDataJSON,
        origin: originBytes(fields.origin),
        r: fields.r,
        s: fields.s
      }
    ]
  );
}

/**
 * The account-level signature envelope: `abi.encode(validator, validatorSignature)`,
 * exactly as `LoomAccount` splits it during validation.
 */
export function encodeValidatorSignature(validator: Address, validatorSignature: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [assertAddress(validator), validatorSignature]
  );
}

/**
 * Parse an authenticator's P-256 signature — 64-byte raw `r || s` or ASN.1 DER —
 * into `bytes32` components, normalized to low-s. Malformed input fails closed.
 */
export function parseP256Signature(signature: Hex): { r: Hex; s: Hex } {
  const size = sizeOfHex(signature);
  let r: bigint;
  let s: bigint;
  if (size === 64) {
    r = fromHex(sliceHex(signature, 0, 32));
    s = fromHex(sliceHex(signature, 32, 64));
  } else {
    [r, s] = parseDer(signature, size);
  }
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) {
    throw invalidSignature("p256 signature component out of range");
  }
  if (s > P256_HALF_N) s = P256_N - s;
  return { r: toBeHex(r, 32), s: toBeHex(s, 32) };
}

function parseDer(signature: Hex, size: number): [bigint, bigint] {
  // SEQUENCE(0x30) len INTEGER(0x02) rlen r INTEGER(0x02) slen s
  const byteAt = (index: number) => Number(fromHex(sliceHex(signature, index, index + 1)));
  if (size < 8 || byteAt(0) !== 0x30 || byteAt(1) !== size - 2) {
    throw invalidSignature("signature is neither 64-byte r||s nor a DER sequence");
  }
  const readInteger = (offset: number): [bigint, number] => {
    if (byteAt(offset) !== 0x02) throw invalidSignature("DER integer tag missing");
    const length = byteAt(offset + 1);
    if (length === 0 || length > 33 || offset + 2 + length > size) {
      throw invalidSignature("DER integer length invalid");
    }
    return [fromHex(sliceHex(signature, offset + 2, offset + 2 + length)), offset + 2 + length];
  };
  const [r, afterR] = readInteger(2);
  const [s, afterS] = readInteger(afterR);
  if (afterS !== size) throw invalidSignature("DER sequence has trailing bytes");
  return [r, s];
}

function invalidSignature(message: string): LoomError {
  return new LoomError("SIGNATURE_INVALID", message, { safeMessage: "invalid p256 signature" });
}

const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Unpadded base64url of hex bytes — the exact challenge text a WebAuthn
 * `clientDataJSON` must carry for the on-chain challenge binding.
 */
export function base64UrlEncode(data: Hex): string {
  const body = data.slice(2);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 2) {
    bytes.push(Number.parseInt(body.slice(index, index + 2), 16));
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index], bytes[index + 1], bytes[index + 2]];
    const chunk = ((a ?? 0) << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += BASE64_URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_URL_ALPHABET[(chunk >> 12) & 63];
    if (b !== undefined) output += BASE64_URL_ALPHABET[(chunk >> 6) & 63];
    if (c !== undefined) output += BASE64_URL_ALPHABET[chunk & 63];
  }
  return output;
}
