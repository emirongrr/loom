import type { Address } from "@loom/core";
import { formatUnits, getAddress, isAddress } from "viem";
import { receiveChainLabel } from "./receiveTarget.ts";
import { nativeSendReserve } from "./sendLimits.ts";
import type { SendableAsset } from "./transfers.ts";

/**
 * What a person is about to authorise, assembled from the draft they can see.
 *
 * Rendered inline rather than behind a "review" step. A separate confirmation
 * screen would add a click without adding information, and the brief this
 * implements asks for review and submission combined *without hiding important
 * transaction details* — so the details sit above the button that acts on them
 * and update as the draft changes.
 */
export interface SendReview {
  /** Asset label: a token symbol, or a collection and token id. */
  readonly asset: string;
  /** Checksummed recipient, or null while the draft has no usable address. */
  readonly recipient: Address | null;
  /** Amount with its symbol, or null for a single collectible. */
  readonly amount: string | null;
  readonly network: string;
  /** The account itself: a Loom account funds its own operation. */
  readonly gasPayer: Address;
  /** Fee ceiling in native units, or null when the price cannot be read. */
  readonly maxFee: string | null;
  /**
   * Always true. The figure comes from a gas price and a conservative gas
   * ceiling, not from a bundler estimate, so it is an upper bound and the UI
   * must not present it as a prediction.
   */
  readonly feeIsUpperBound: true;
  /** Whether the draft is complete enough to authorise. */
  readonly complete: boolean;
}

export function buildSendReview(input: {
  readonly asset: SendableAsset;
  readonly recipient: string;
  readonly amount: string;
  readonly account: Address;
  readonly chainId: number;
  readonly maxFeePerGas: bigint | null;
}): SendReview {
  const trimmed = input.recipient.trim();
  const recipient = isAddress(trimmed, { strict: false }) ? (getAddress(trimmed) as Address) : null;
  const isNft = input.asset.type === "nft";

  const asset = input.asset.type === "token"
    ? input.asset.token.symbol
    : `${input.asset.nft.collection} #${input.asset.nft.tokenId}`;

  const amountValue = input.amount.trim();
  const amountLooksUsable = /^\d*\.?\d*$/.test(amountValue) && amountValue !== "" && amountValue !== "." && Number(amountValue) > 0;
  const amount = isNft
    ? null
    : amountLooksUsable && input.asset.type === "token"
      ? `${amountValue} ${input.asset.token.symbol}`
      : null;

  // The fee is always paid in the native token, whatever is being sent.
  const maxFee = input.maxFeePerGas === null || input.maxFeePerGas <= 0n
    ? null
    : formatUnits(nativeSendReserve({ maxFeePerGas: input.maxFeePerGas }), 18);

  return Object.freeze({
    asset,
    recipient,
    amount,
    network: networkLabel(input.chainId),
    gasPayer: input.account,
    maxFee,
    feeIsUpperBound: true as const,
    complete: recipient !== null && (isNft || amount !== null)
  });
}

/** Named chains read as "Sepolia · chain 11155111"; unknown ones as "Chain 918273". */
function networkLabel(chainId: number): string {
  const label = receiveChainLabel(chainId);
  return label === `Chain ${chainId}` ? label : `${label} · chain ${chainId}`;
}
