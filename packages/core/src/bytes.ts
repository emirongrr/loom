import { LoomError } from "./errors.js";
import type { Hex } from "./hex.js";
import { isHex } from "./hex.js";

function assertHexInput(value: unknown): Hex {
  if (!isHex(value) || value.length % 2 !== 0) {
    throw new LoomError("CONFIG_INVALID", `invalid hex: ${String(value)}`, { safeMessage: "invalid hex" });
  }
  return value;
}

/** Byte length of a hex string (excluding the `0x` prefix). */
export function sizeOfHex(hex: Hex): number {
  return assertHexInput(hex).length / 2 - 1;
}

/** Big-endian, fixed-width hex encoding of a non-negative integer. */
export function toBeHex(value: bigint | number, byteLength: number): Hex {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) {
    throw new LoomError("CONFIG_INVALID", "value must be non-negative", { safeMessage: "value out of range" });
  }
  const digits = big.toString(16);
  if (digits.length > byteLength * 2) {
    throw new LoomError("CONFIG_INVALID", `value exceeds ${byteLength} bytes`, { safeMessage: "value out of range" });
  }
  return `0x${digits.padStart(byteLength * 2, "0")}`;
}

/** Parse a hex string into a big integer. Empty (`0x`) decodes to `0`. */
export function fromHex(hex: Hex): bigint {
  const body = assertHexInput(hex).slice(2);
  return body.length === 0 ? 0n : BigInt(`0x${body}`);
}

/** Concatenate hex strings into one. */
export function concatHex(...parts: Hex[]): Hex {
  return `0x${parts.map(part => assertHexInput(part).slice(2)).join("")}`;
}

/** Slice a hex string by byte offsets (end exclusive; defaults to the end). */
export function sliceHex(hex: Hex, startByte: number, endByte?: number): Hex {
  const body = assertHexInput(hex).slice(2);
  const end = endByte === undefined ? body.length : endByte * 2;
  return `0x${body.slice(startByte * 2, end)}`;
}

/** Pack two `uint128` values into a single big-endian `bytes32` (high then low). */
export function packUint128Pair(high: bigint, low: bigint): Hex {
  return concatHex(toBeHex(high, 16), toBeHex(low, 16));
}

/** Split a `bytes32` word into its high and low `uint128` values. */
export function unpackUint128Pair(word: Hex): readonly [bigint, bigint] {
  return [fromHex(sliceHex(word, 0, 16)), fromHex(sliceHex(word, 16, 32))];
}
