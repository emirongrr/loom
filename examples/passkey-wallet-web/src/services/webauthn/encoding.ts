import type { Hex } from "@loom/core";

export function hexFromBytes(value: Uint8Array): Hex {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function bytesFromHex(value: Hex, message = "Passkey byte data is invalid."): Uint8Array<ArrayBuffer> {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error(message);
  const pairs = value.slice(2).match(/../g) ?? [];
  const output = new Uint8Array(pairs.length);
  for (let index = 0; index < pairs.length; index += 1) output[index] = Number.parseInt(pairs[index]!, 16);
  return output;
}

export function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

export function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(value.length);
  output.set(value);
  return output.buffer;
}

export function derP256SignatureToRaw(signature: Uint8Array): Uint8Array {
  if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) throw invalidSignature();
  let offset = 2;
  const integer = (): Uint8Array => {
    if (signature[offset] !== 0x02) throw invalidSignature();
    const length = signature[offset + 1];
    if (length === undefined || length < 1 || length > 33 || offset + 2 + length > signature.length) throw invalidSignature();
    let value = signature.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    if (value.length === 33) {
      if (value[0] !== 0 || (value[1]! & 0x80) === 0) throw invalidSignature();
      value = value.slice(1);
    } else if ((value[0]! & 0x80) !== 0 || (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0)) {
      throw invalidSignature();
    }
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = integer();
  const s = integer();
  if (offset !== signature.length) throw invalidSignature();
  return concatBytes(r, s);
}

function invalidSignature(): Error {
  return new Error("Passkey signature encoding is invalid.");
}
