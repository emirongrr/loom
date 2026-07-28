import type { Address } from "@loom/core";
import { createPublicClient, formatEther, formatUnits, getAddress, http } from "viem";
import type { NetworkConfig } from "../../config/network";

export interface TokenAsset {
  readonly kind: "native" | "erc20";
  readonly address?: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly balance: bigint;
  readonly formatted: string;
  readonly icon?: string;
}

export interface NftAsset {
  readonly contract: Address;
  readonly tokenId: string;
  readonly standard: "erc721" | "erc1155";
  readonly name: string;
  readonly collection: string;
  readonly image?: string;
  readonly amount?: string;
}

export interface AccountAssets {
  readonly native: TokenAsset;
  readonly tokens: readonly TokenAsset[];
  readonly nfts: readonly NftAsset[];
  /** Whether the account has code on chain, read from the RPC. */
  readonly deployed: boolean;
  /** True when token discovery failed; the native balance is still real. */
  readonly discoveryUnavailable: boolean;
  /** True when collectible discovery failed independently of token discovery. */
  readonly nftDiscoveryUnavailable: boolean;
}

export interface AccountBalance {
  readonly wei: bigint;
  readonly eth: string;
  readonly deployed: boolean;
}

// The account's native balance and whether it has code, read straight from the
// RPC. No signature and no authority — just the truth the chain exposes about
// the address, so the wallet never invents a balance or deployment status.
export async function readAccountBalance(config: NetworkConfig, account: Address): Promise<AccountBalance> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const [wei, code] = await Promise.all([
    client.getBalance({ address: account }),
    client.getCode({ address: account })
  ]);
  return { wei, eth: formatEther(wei), deployed: Boolean(code && code !== "0x") };
}

// Discover fungible tokens and collectibles for an account. The native ETH
// balance is read straight from the RPC; ERC-20 and NFT discovery uses the
// configured block explorer's public index. Discovery failures degrade to
// "native only" rather than throwing — the wallet never blocks on an indexer.
export async function readAccountAssets(config: NetworkConfig, account: Address): Promise<AccountAssets> {
  const balance = await readAccountBalance(config, account);
  const native = nativeAsset(balance.wei, balance.eth);
  // Token and collectible discovery are settled independently: a rate-limited or
  // failing collectible lookup must never hide tokens the indexer did return.
  const [tokens, nfts] = await Promise.allSettled([
    readErc20Tokens(config, account),
    readNfts(config, account)
  ]);
  return {
    native,
    tokens: tokens.status === "fulfilled" ? tokens.value : [],
    nfts: nfts.status === "fulfilled" ? nfts.value : [],
    deployed: balance.deployed,
    discoveryUnavailable: tokens.status === "rejected",
    nftDiscoveryUnavailable: nfts.status === "rejected"
  };
}

function nativeAsset(wei: bigint, eth: string): TokenAsset {
  return { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: wei, formatted: trimAmount(eth) };
}

async function readErc20Tokens(config: NetworkConfig, account: Address): Promise<readonly TokenAsset[]> {
  const url = `${explorerApi(config)}/addresses/${account}/token-balances`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`token discovery returned ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) return [];
  const tokens: TokenAsset[] = [];
  for (const row of rows) {
    const token = (row as { token?: Record<string, unknown> }).token;
    const rawValue = (row as { value?: unknown }).value;
    if (!token || String(token.type) !== "ERC-20") continue;
    const contract = tokenAddress(token);
    if (!contract) continue;
    const decimals = Number(token.decimals);
    const balance = safeBigInt(rawValue);
    if (balance === null || balance === 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const icon = typeof token.icon_url === "string" && token.icon_url.startsWith("https://") ? token.icon_url : undefined;
    tokens.push({
      kind: "erc20",
      address: contract,
      symbol: cleanText(token.symbol, "TOKEN", 12),
      name: cleanText(token.name, "Token", 40),
      decimals,
      balance,
      formatted: trimAmount(formatUnits(balance, decimals)),
      ...(icon ? { icon } : {})
    });
  }
  return tokens.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function readNfts(config: NetworkConfig, account: Address): Promise<readonly NftAsset[]> {
  const url = `${explorerApi(config)}/addresses/${account}/nft?type=ERC-721,ERC-1155`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`nft discovery returned ${response.status}`);
  const body: unknown = await response.json();
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const nfts: NftAsset[] = [];
  for (const item of items.slice(0, 48)) {
    const record = item as Record<string, unknown>;
    const token = record.token as Record<string, unknown> | undefined;
    if (!token) continue;
    const contract = tokenAddress(token);
    if (!contract) continue;
    const tokenId = record.id ?? record.token_id;
    if (tokenId === undefined || tokenId === null) continue;
    const metadata = record.metadata as Record<string, unknown> | undefined;
    const image = imageUrl(record);
    nfts.push({
      contract,
      tokenId: String(tokenId),
      standard: String(token.type) === "ERC-1155" ? "erc1155" : "erc721",
      name: cleanText(metadata?.name, `#${String(tokenId).slice(0, 8)}`, 60),
      collection: cleanText(token.name, "Collectible", 40),
      ...(image ? { image } : {}),
      ...(record.value ? { amount: String(record.value) } : {})
    });
  }
  return nfts;
}

function imageUrl(record: Record<string, unknown>): string | undefined {
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const candidate = record.image_url ?? metadata?.image ?? metadata?.image_url;
  if (typeof candidate !== "string") return undefined;
  if (candidate.startsWith("https://")) return candidate;
  if (candidate.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${candidate.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  return undefined;
}

function explorerApi(config: NetworkConfig): string {
  return `${config.explorerUrl.replace(/\/$/, "")}/api/v2`;
}

// Blockscout returns the contract as `address_hash`; older versions and some
// compatible indexers use `address`. Accept either rather than silently
// dropping every row when the key name differs.
function tokenAddress(token: Record<string, unknown>): Address | null {
  for (const candidate of [token.address_hash, token.address]) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate)) return getAddress(candidate);
  }
  return null;
}

function safeBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text.slice(0, max) : fallback;
}

function trimAmount(value: string): string {
  if (!value.includes(".")) return value;
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "").slice(0, 6);
  return trimmed ? `${whole}.${trimmed}` : whole;
}
