import type { Address } from "@loom/core";
import { getAddress, isAddress } from "viem";

/**
 * What a scanned code is allowed to put in the recipient field.
 *
 * A camera is an input a person aims rather than reads, so this refuses
 * anything it cannot honour exactly instead of extracting the part it happens
 * to understand. Two refusals matter more than the rest:
 *
 * - a payment URI for another chain, because quietly moving an address onto a
 *   network the sender never chose is the one receive mistake that is usually
 *   unrecoverable;
 * - a token-transfer request, because keeping only its address would drop the
 *   asset and amount it asked for and send the wrong thing from a screen that
 *   looked like it had understood.
 *
 * Refusals never echo the scanned value: a code can carry anything, and
 * reflecting it into the page is how a scanner becomes an injection surface.
 */
export type ScannedRecipient =
  | { readonly kind: "address"; readonly address: Address }
  | { readonly kind: "rejected"; readonly reason: string };

/** A QR code holding an address or a payment URI is far below this. */
const MAX_PAYLOAD = 512;

export function parseScannedRecipient(value: string, expected: { readonly chainId: number }): ScannedRecipient {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PAYLOAD) {
    return rejected("That code could not be read as an address.");
  }
  const trimmed = value.trim();

  if (isAddress(trimmed, { strict: false })) {
    return { kind: "address", address: getAddress(trimmed) as Address };
  }

  if (!/^ethereum:/iu.test(trimmed)) {
    return rejected("That code is not an Ethereum address.");
  }

  const body = trimmed.slice("ethereum:".length);
  if (body.includes("/") || body.includes("?")) {
    return rejected("That code asks for a token transfer, which this screen cannot set up. Choose the asset here and scan a plain address instead.");
  }

  const [target, chain] = body.split("@");
  if (!target || !isAddress(target, { strict: false })) {
    return rejected("That code is not an Ethereum address.");
  }
  if (chain !== undefined) {
    if (!/^\d+$/u.test(chain) || Number(chain) !== expected.chainId) {
      return rejected("That code is for another network. Sending there from here would lose the transfer.");
    }
  }
  return { kind: "address", address: getAddress(target) as Address };
}

function rejected(reason: string): ScannedRecipient {
  return { kind: "rejected", reason };
}
