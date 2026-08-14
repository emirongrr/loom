import type { Address } from "@loom/core";
import { getAddress, isAddress } from "viem";

/**
 * Everything the receive sheet needs, derived locally.
 *
 * No address book, no hosted resolver, no image service: the QR is drawn in the
 * page and the address comes from the open wallet handle. A receive screen that
 * called out to anything would leak the one fact the user is about to publish
 * anyway — but to a party they never chose.
 */
export interface ReceiveTarget {
  /** EIP-55 checksummed, so a misread character is detectable by the sender. */
  readonly address: Address;
  readonly chainId: number;
  readonly chainLabel: string;
  /** What the QR encodes. Deliberately the bare address. */
  readonly qrPayload: string;
  /** EIP-681 pay-to-address URI, offered as a chain-bound alternative. */
  readonly uri: string;
  readonly deployed: boolean;
}

const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "Ethereum",
  10: "OP Mainnet",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  11155111: "Sepolia",
  84532: "Base Sepolia"
});

export function receiveChainLabel(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function createReceiveTarget(input: {
  readonly address: string;
  readonly chainId: number;
  readonly deployed: boolean;
}): ReceiveTarget {
  if (typeof input.address !== "string" || !isAddress(input.address, { strict: false })) {
    throw new Error("This wallet has no usable receive address.");
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("This wallet has no usable network.");
  }
  const address = getAddress(input.address) as Address;
  return Object.freeze({
    address,
    chainId: input.chainId,
    chainLabel: receiveChainLabel(input.chainId),
    // The QR carries the bare address because every wallet scanner accepts one.
    // An EIP-681 URI binds the chain, which is strictly better information, but
    // a scanner that cannot parse it fails outright — and failing to receive is
    // a worse outcome than a plain address shown beside a named network.
    qrPayload: address,
    uri: `ethereum:${address}@${input.chainId}`,
    deployed: input.deployed === true
  });
}
