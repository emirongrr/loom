import assert from "node:assert/strict";
import test from "node:test";

import { readAccountAssets } from "../src/features/wallet/assets.ts";
import { createPublicClientRegistry } from "../src/services/rpc/publicClients.ts";
import { buildTransferCall, normalizeRecipient } from "../src/features/wallet/transfers.ts";
import type { NftAsset, TokenAsset } from "../src/features/wallet/assets.ts";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const RECIPIENT = "0x00000000000000000000000000000000000000b2";
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const COLLECTION = "0x2a0f1C1cE263202f629bF41FA7Caa3D5F8FD52C4";

const CONFIG = {
  rpcUrl: "https://rpc.example",
  bundlerUrl: "https://bundler.example",
  explorerUrl: "https://explorer.example",
  relayUrl: ""
} as const;

// One registry for the file, as the app keeps one for the session.
const CLIENTS = createPublicClientRegistry();

// The explorer returns the contract as `address_hash`; reading only `address`
// silently dropped every balance row and showed an assetless wallet.
test("token discovery reads the explorer's address_hash contract key", async () => {
  const fetchMock = explorerFetch({
    tokenBalances: [{
      token: { address_hash: TOKEN, decimals: "6", name: "USDC", symbol: "USDC", type: "ERC-20", icon_url: "https://cdn.example/usdc.png" },
      value: "2500000"
    }],
    nfts: { items: [] }
  });
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.equal(assets.discoveryUnavailable, false);
  assert.equal(assets.tokens.length, 1);
  const [token] = assets.tokens;
  assert.equal(token?.symbol, "USDC");
  assert.equal(token?.decimals, 6);
  assert.equal(token?.balance, 2_500_000n);
  assert.equal(token?.formatted, "2.5");
  assert.equal(token?.icon, "https://cdn.example/usdc.png");
});

test("token discovery skips zero balances, non-ERC-20 rows, and malformed contracts", async () => {
  const fetchMock = explorerFetch({
    tokenBalances: [
      { token: { address_hash: TOKEN, decimals: "6", symbol: "ZERO", type: "ERC-20" }, value: "0" },
      { token: { address_hash: TOKEN, decimals: "0", symbol: "NFT", type: "ERC-721" }, value: "1" },
      { token: { address_hash: "not-an-address", decimals: "18", symbol: "BAD", type: "ERC-20" }, value: "5" },
      { token: { address_hash: TOKEN, decimals: "18", symbol: "OK", type: "ERC-20" }, value: "1000000000000000000" }
    ],
    nfts: { items: [] }
  });
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.deepEqual(assets.tokens.map(token => token.symbol), ["OK"]);
  assert.equal(assets.tokens[0]?.formatted, "1");
});

test("collectible discovery keeps only https or ipfs-gateway artwork", async () => {
  const fetchMock = explorerFetch({
    tokenBalances: [],
    nfts: {
      items: [
        { id: "7", token: { address_hash: COLLECTION, name: "Loom Test", type: "ERC-721" }, metadata: { name: "Seven", image: "ipfs://QmHash/7.png" } },
        { id: "8", token: { address_hash: COLLECTION, name: "Loom Test", type: "ERC-1155" }, value: "3", metadata: { name: "Eight", image: "javascript:alert(1)" } }
      ]
    }
  });
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.equal(assets.nfts.length, 2);
  assert.equal(assets.nfts[0]?.standard, "erc721");
  assert.equal(assets.nfts[0]?.image, "https://ipfs.io/ipfs/QmHash/7.png");
  assert.equal(assets.nfts[1]?.standard, "erc1155");
  assert.equal(assets.nfts[1]?.image, undefined, "a non-https scheme must never reach an img src");
});

// An unreachable indexer must not hide the balance the RPC already proved.
test("a failing explorer degrades to the native balance instead of throwing", async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/v2/")) return new Response("nope", { status: 502 });
    return rpcResponse(init);
  };
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.equal(assets.discoveryUnavailable, true);
  assert.equal(assets.tokens.length, 0);
  assert.equal(assets.native.formatted, "1.5");
  assert.equal(assets.deployed, true);
});

// Regression: both lookups shared one Promise.all, so a rate-limited collectible
// endpoint discarded the token balances the indexer had already returned.
test("a failing collectible lookup does not hide token balances", async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/token-balances")) {
      return Response.json([{ token: { address_hash: TOKEN, decimals: "6", symbol: "PYUSD", type: "ERC-20" }, value: "75000000" }]);
    }
    if (url.includes("/nft")) return new Response("rate limited", { status: 429 });
    return rpcResponse(init);
  };
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.equal(assets.tokens.length, 1, "tokens must survive a collectible failure");
  assert.equal(assets.tokens[0]?.symbol, "PYUSD");
  assert.equal(assets.tokens[0]?.formatted, "75");
  assert.equal(assets.discoveryUnavailable, false);
  assert.equal(assets.nftDiscoveryUnavailable, true);
});

test("a failing token lookup does not hide collectibles", async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/token-balances")) return new Response("rate limited", { status: 429 });
    if (url.includes("/nft")) return Response.json({ items: [{ id: "7", token: { address_hash: COLLECTION, name: "Loom Test", type: "ERC-721" } }] });
    return rpcResponse(init);
  };
  const assets = await withFetch(fetchMock, () => readAccountAssets(CONFIG, ACCOUNT, CLIENTS));

  assert.equal(assets.nfts.length, 1);
  assert.equal(assets.discoveryUnavailable, true);
  assert.equal(assets.nftDiscoveryUnavailable, false);
});

test("recipient parsing rejects anything that is not an address", () => {
  assert.throws(() => normalizeRecipient("0x1234"), /valid recipient/u);
  assert.throws(() => normalizeRecipient(""), /valid recipient/u);
  assert.equal(normalizeRecipient(` ${RECIPIENT} `).toLowerCase(), RECIPIENT);
});

test("a native transfer moves value directly and carries no calldata", () => {
  const call = buildTransferCall({ asset: { type: "token", token: nativeToken() }, from: ACCOUNT, to: RECIPIENT, amount: "0.25" });
  assert.equal(call.target, RECIPIENT);
  assert.equal(call.value, 250_000_000_000_000_000n);
  assert.equal(call.data, "0x");
});

test("an ERC-20 transfer encodes transfer(to,amount) against the token, with no value", () => {
  const call = buildTransferCall({ asset: { type: "token", token: erc20Token() }, from: ACCOUNT, to: RECIPIENT, amount: "2.5" });
  assert.equal(call.target, TOKEN);
  assert.equal(call.value, 0n);
  // transfer(address,uint256)
  assert.ok(call.data.startsWith("0xa9059cbb"));
  assert.ok(call.data.toLowerCase().includes(RECIPIENT.slice(2)));
  // 2.5 with 6 decimals = 2_500_000 = 0x2625a0
  assert.ok(call.data.endsWith("2625a0"));
});

test("an amount over the token balance is refused before signing", () => {
  assert.throws(
    () => buildTransferCall({ asset: { type: "token", token: erc20Token() }, from: ACCOUNT, to: RECIPIENT, amount: "999" }),
    /exceeds/u
  );
});

test("a native amount over the account balance is refused before bundler simulation", () => {
  assert.throws(
    () => buildTransferCall({ asset: { type: "token", token: nativeToken() }, from: ACCOUNT, to: RECIPIENT, amount: "1.000000000000000001" }),
    /exceeds/u
  );
});

test("a zero or malformed amount is refused", () => {
  for (const amount of ["0", "", ".", "abc", "-1"]) {
    assert.throws(() => buildTransferCall({ asset: { type: "token", token: nativeToken() }, from: ACCOUNT, to: RECIPIENT, amount }));
  }
});

test("collectible transfers use safeTransferFrom with the account as sender", () => {
  const erc721 = buildTransferCall({ asset: { type: "nft", nft: nft("erc721") }, from: ACCOUNT, to: RECIPIENT, amount: "1" });
  assert.equal(erc721.target, COLLECTION);
  assert.equal(erc721.value, 0n);
  // safeTransferFrom(address,address,uint256)
  assert.ok(erc721.data.startsWith("0x42842e0e"));
  assert.ok(erc721.data.toLowerCase().includes(ACCOUNT.slice(2)), "the account must be the sender");

  const erc1155 = buildTransferCall({ asset: { type: "nft", nft: nft("erc1155") }, from: ACCOUNT, to: RECIPIENT, amount: "1" });
  // safeTransferFrom(address,address,uint256,uint256,bytes)
  assert.ok(erc1155.data.startsWith("0xf242432a"));
});

function nativeToken(): TokenAsset {
  return { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1" };
}

function erc20Token(): TokenAsset {
  return { kind: "erc20", address: TOKEN, symbol: "USDC", name: "USDC", decimals: 6, balance: 10_000_000n, formatted: "10" };
}

function nft(standard: "erc721" | "erc1155"): NftAsset {
  return { contract: COLLECTION, tokenId: "7", standard, name: "Seven", collection: "Loom Test" };
}

function explorerFetch(data: { tokenBalances: unknown; nfts: unknown }): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/token-balances")) return Response.json(data.tokenBalances);
    if (url.includes("/nft")) return Response.json(data.nfts);
    return rpcResponse(init);
  };
}

// Minimal JSON-RPC stand-in: 1.5 ETH held by an account that has code.
async function rpcResponse(init: RequestInit | undefined): Promise<Response> {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const calls = Array.isArray(body) ? body : [body];
  const results = calls.map((call: { id?: number; method?: string }) => ({
    jsonrpc: "2.0",
    id: call.id ?? 1,
    result: call.method === "eth_getBalance" ? "0x14d1120d7b160000" // 1.5 ETH
      : call.method === "eth_getCode" ? "0x60806040"
      : "0x"
  }));
  return Response.json(Array.isArray(body) ? results : results[0]);
}

async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}
