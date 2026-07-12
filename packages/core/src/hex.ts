import { LoomError } from "./errors.js";

/** A `0x`-prefixed hexadecimal string of arbitrary (even) length. */
export type Hex = `0x${string}`;

/** A `0x`-prefixed 20-byte Ethereum address. */
export type Address = `0x${string}`;

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Whether `value` is a `0x`-prefixed hex string. */
export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

/** Whether `value` is a well-formed 20-byte address. */
export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Assert and return a well-formed address, or raise a {@link LoomError}. */
export function assertAddress(value: unknown): Address {
  if (!isAddress(value)) {
    throw new LoomError("CONFIG_INVALID", `invalid address: ${String(value)}`, {
      safeMessage: "invalid address"
    });
  }
  return value;
}

/**
 * Case-insensitive equality for hex strings. Address and code-hash comparisons
 * must not depend on checksum casing; this is the canonical comparator.
 */
export function equalHex(a: unknown, b: unknown): boolean {
  return isHex(a) && isHex(b) && a.toLowerCase() === b.toLowerCase();
}
