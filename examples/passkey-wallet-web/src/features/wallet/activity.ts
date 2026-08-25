import type { Address } from "@loom/core";
import { formatEther, formatUnits, getAddress } from "viem";
import type { NetworkConfig } from "../../config/network";
import type { ActivityItem, ActivityKind, ActivityStatus } from "../../types";
import { shortAddress } from "../../components/address.ts";

// How many confirmations before an inclusion is presented as settled. The
// explorer reports confirmations; the wallet does not invent finality.
const FINALITY_CONFIRMATIONS = 64;
// Bounds on the opaque page cursor the indexer hands back. It is untrusted input
// that ends up in a query string, so its shape is constrained rather than trusted.
const MAX_CURSOR_KEYS = 16;
const MAX_CURSOR_KEY_LENGTH = 64;
const MAX_CURSOR_VALUE_LENGTH = 256;

/** Opaque per-source continuation tokens. A null source is exhausted. */
export interface ActivityCursor {
  readonly transactions: PageParams | null;
  readonly transfers: PageParams | null;
}

type PageParams = Readonly<Record<string, string>>;

export interface AccountActivity {
  readonly items: readonly ActivityItem[];
  /** Cursor for the next page, or null when both sources are exhausted. */
  readonly cursor: ActivityCursor | null;
  /** True when the indexer could not be reached; history is unknown, not empty. */
  readonly unavailable: boolean;
}

// Read account history from the configured explorer's index. Two sources are
// merged: plain transactions (native value, contract calls, deployment) and token
// transfer logs (ERC-20/721/1155), which carry the detail a transaction alone
// does not. Entries are keyed per transaction so one transfer is listed once.
//
// This is an indexer, not a trust anchor: it can omit or mislabel history, so it
// is presented as history and never as account authority or balance truth. A
// failure degrades to "unavailable" rather than an empty history.
// Passing the previous cursor continues where that page stopped. The full merged
// page is returned rather than a trimmed slice: trimming would drop entries the
// advancing cursor can never return, silently losing history.
export async function readAccountActivity(
  config: NetworkConfig,
  account: Address,
  options: { cursor?: ActivityCursor | null } = {}
): Promise<AccountActivity> {
  const base = `${config.explorerUrl.replace(/\/$/, "")}/api/v2/addresses/${account}`;
  const cursor = options.cursor;
  // On a continuation, an exhausted source is not requested again.
  const first = cursor === undefined || cursor === null;
  try {
    const [transactions, transfers] = await Promise.all([
      first || cursor.transactions ? readPage(`${base}/transactions`, first ? null : cursor.transactions) : emptyPage(),
      first || cursor.transfers ? readPage(`${base}/token-transfers`, first ? null : cursor.transfers) : emptyPage()
    ]);

    const items = new Map<string, ActivityItem>();
    // Transactions first, then let the richer token-transfer detail win.
    for (const row of transactions.items) {
      const item = parseTransaction(row, account);
      if (item) items.set(item.id, item);
    }
    for (const row of transfers.items) {
      const item = parseTokenTransfer(row, account);
      if (item) items.set(item.id, item);
    }

    const next: ActivityCursor = { transactions: transactions.next, transfers: transfers.next };
    return {
      items: Object.freeze([...items.values()].sort((a, b) => b.timestamp - a.timestamp)),
      cursor: next.transactions || next.transfers ? Object.freeze(next) : null,
      unavailable: false
    };
  } catch {
    return { items: Object.freeze([]), cursor: null, unavailable: true };
  }
}

interface IndexerPage {
  readonly items: readonly Record<string, unknown>[];
  readonly next: PageParams | null;
}

function emptyPage(): IndexerPage {
  return { items: [], next: null };
}

async function readPage(url: string, params: PageParams | null): Promise<IndexerPage> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const response = await fetch(`${url}${query}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`activity lookup returned ${response.status}`);
  const body: unknown = await response.json();
  const items = (body as { items?: unknown }).items;
  return {
    items: Array.isArray(items) ? (items as Record<string, unknown>[]) : [],
    next: parseCursor((body as { next_page_params?: unknown }).next_page_params)
  };
}

// The continuation token is opaque but still untrusted, and it is appended to a
// query string. Only bounded scalar entries are carried forward; anything else
// (nested objects, oversized blobs, absurd key counts) ends pagination instead of
// being forwarded to the indexer.
function parseCursor(value: unknown): PageParams | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_CURSOR_KEYS) return null;
  const params: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_CURSOR_KEY_LENGTH) return null;
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") return null;
    const text = String(entry);
    if (text.length > MAX_CURSOR_VALUE_LENGTH) return null;
    params[key] = text;
  }
  return Object.keys(params).length > 0 ? Object.freeze(params) : null;
}

function parseTransaction(row: Record<string, unknown>, account: Address): ActivityItem | null {
  const hash = hexHash(row.hash);
  const timestamp = parseTimestamp(row.timestamp);
  if (!hash || timestamp === null) return null;

  const from = addressOf(row.from);
  const to = addressOf(row.to);
  const direction = directionOf(from, to, account);
  const value = bigIntOf(row.value) ?? 0n;
  const created = addressOf((row.created_contract as Record<string, unknown> | undefined)?.hash ?? row.created_contract);

  let kind: ActivityKind = "call";
  let title: string;
  if (created && direction !== "received") {
    kind = "deployment";
    title = "Account deployed";
  } else if (value > 0n) {
    kind = "native";
    title = direction === "received" ? "Received ETH" : direction === "self" ? "Sent ETH to self" : "Sent ETH";
  } else {
    title = methodLabel(row.method) ?? "Contract interaction";
  }

  return Object.freeze({
    id: hash,
    kind,
    direction,
    status: statusOf(row),
    title,
    ...(kind === "native" ? { amount: `${trimAmount(formatEther(value))} ETH` } : {}),
    detail: counterparty(direction, from, to),
    timestamp,
    hash
  });
}

function parseTokenTransfer(row: Record<string, unknown>, account: Address): ActivityItem | null {
  const hash = hexHash(row.transaction_hash);
  const timestamp = parseTimestamp(row.timestamp);
  if (!hash || timestamp === null) return null;

  const token = (row.token ?? {}) as Record<string, unknown>;
  const standard = String(row.token_type ?? token.type ?? "");
  const total = (row.total ?? {}) as Record<string, unknown>;
  const from = addressOf(row.from);
  const to = addressOf(row.to);
  const direction = directionOf(from, to, account);
  const symbol = text(token.symbol, "tokens", 12);
  const isNft = standard === "ERC-721" || standard === "ERC-1155";

  const tokenId = total.token_id ?? row.token_id;
  const amount = isNft
    ? `${symbol} #${String(tokenId ?? "?").slice(0, 12)}`
    : `${formatTokenTotal(total, token)} ${symbol}`;

  return Object.freeze({
    id: hash,
    kind: isNft ? "nft" : "token",
    direction,
    status: statusOf(row),
    title: `${direction === "received" ? "Received" : direction === "self" ? "Moved" : "Sent"} ${isNft ? "collectible" : symbol}`,
    amount,
    detail: counterparty(direction, from, to),
    timestamp,
    hash
  });
}

function formatTokenTotal(total: Record<string, unknown>, token: Record<string, unknown>): string {
  const value = bigIntOf(total.value);
  if (value === null) return "?";
  const decimals = Number(total.decimals ?? token.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return value.toString();
  return trimAmount(formatUnits(value, decimals));
}

// A transaction the indexer reports as reverted is a failure, not a transfer.
// Confirmation depth decides whether an inclusion is shown as settled.
function statusOf(row: Record<string, unknown>): ActivityStatus {
  const status = String(row.status ?? "").toLowerCase();
  const result = String(row.result ?? "").toLowerCase();
  if (status === "error" || result === "error" || (result !== "" && result !== "success" && result !== "ok")) return "failed";
  if (row.block_number === null || row.block_number === undefined) return "pending";
  const confirmations = Number(row.confirmations);
  if (Number.isFinite(confirmations) && confirmations >= FINALITY_CONFIRMATIONS) return "finalized";
  return "included";
}

function directionOf(from: Address | null, to: Address | null, account: Address): ActivityItem["direction"] {
  const owned = account.toLowerCase();
  const isFrom = from?.toLowerCase() === owned;
  const isTo = to?.toLowerCase() === owned;
  if (isFrom && isTo) return "self";
  return isFrom ? "sent" : "received";
}

function counterparty(direction: ActivityItem["direction"], from: Address | null, to: Address | null): string {
  if (direction === "self") return "Between your own account";
  const other = direction === "received" ? from : to;
  return other ? `${direction === "received" ? "From" : "To"} ${shortAddress(other)}` : "Contract execution";
}

function methodLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const name = value.trim().slice(0, 40);
  // "safeTransferFrom" -> "Safe transfer from"
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function addressOf(value: unknown): Address | null {
  const candidate = typeof value === "string" ? value : (value as { hash?: unknown } | null)?.hash;
  return typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate) ? getAddress(candidate) : null;
}

function hexHash(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bigIntOf(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function text(value: unknown, fallback: string, max: number): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate.length > 0 ? candidate.slice(0, max) : fallback;
}

function trimAmount(value: string): string {
  if (!value.includes(".")) return value;
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "").slice(0, 6);
  return trimmed ? `${whole}.${trimmed}` : whole;
}

