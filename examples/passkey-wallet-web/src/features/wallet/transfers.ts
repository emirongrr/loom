import type { Address } from "@loom/core";
import { encodeFunctionData, getAddress, isAddress, parseUnits } from "viem";
import type { AccountCall } from "./accountClient";
import type { NftAsset, TokenAsset } from "./assets";

export type SendableAsset =
  | { readonly type: "token"; readonly token: TokenAsset }
  | { readonly type: "nft"; readonly nft: NftAsset };

const ERC20_TRANSFER = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }]
}] as const;

const ERC721_TRANSFER = [{
  type: "function", name: "safeTransferFrom", stateMutability: "nonpayable",
  inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: []
}] as const;

const ERC1155_TRANSFER = [{
  type: "function", name: "safeTransferFrom", stateMutability: "nonpayable",
  inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "id", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "data", type: "bytes" }
  ], outputs: []
}] as const;

export function normalizeRecipient(value: string): Address {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) throw new Error("Enter a valid recipient address.");
  return getAddress(trimmed);
}

// Build the single account call that moves the chosen asset. A fungible amount
// is parsed against the token's decimals; an NFT moves one token id from the
// account itself (the account is the `from`, never a third party).
export function buildTransferCall(input: {
  asset: SendableAsset;
  from: Address;
  to: Address;
  amount: string;
}): AccountCall {
  const { asset, from, to } = input;
  if (asset.type === "token" && asset.token.kind === "native") {
    const value = parseAmount(input.amount, asset.token.decimals);
    if (value > asset.token.balance) throw new Error("Amount exceeds the native balance.");
    return { target: to, value, data: "0x" };
  }
  if (asset.type === "token") {
    const value = parseAmount(input.amount, asset.token.decimals);
    if (value > asset.token.balance) throw new Error("Amount exceeds the token balance.");
    return {
      target: asset.token.address!,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [to, value] })
    };
  }
  const tokenId = BigInt(asset.nft.tokenId);
  if (asset.nft.standard === "erc1155") {
    return {
      target: asset.nft.contract,
      value: 0n,
      data: encodeFunctionData({ abi: ERC1155_TRANSFER, functionName: "safeTransferFrom", args: [from, to, tokenId, 1n, "0x"] })
    };
  }
  return {
    target: asset.nft.contract,
    value: 0n,
    data: encodeFunctionData({ abi: ERC721_TRANSFER, functionName: "safeTransferFrom", args: [from, to, tokenId] })
  };
}

function parseAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") throw new Error("Enter a valid amount.");
  const value = parseUnits(trimmed as `${number}`, decimals);
  if (value <= 0n) throw new Error("Enter an amount greater than zero.");
  return value;
}

export function assetLabel(asset: SendableAsset): string {
  return asset.type === "token" ? asset.token.symbol : `${asset.nft.collection} #${asset.nft.tokenId}`;
}
