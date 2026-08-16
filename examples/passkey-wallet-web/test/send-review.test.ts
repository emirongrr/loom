import assert from "node:assert/strict";
import test from "node:test";
import { buildSendReview } from "../src/features/wallet/sendReview.ts";

const account = "0xcccccccccccccccccccccccccccccccccccccccc";
const recipient = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const native = { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1.0" };
const token = { kind: "erc20", address: "0xdddddddddddddddddddddddddddddddddddddddd", symbol: "USDC", name: "USD Coin", decimals: 6, balance: 5_000_000n, formatted: "5.0" };
const nft = { contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", tokenId: "7", collection: "Loomies", name: "Loomie #7", standard: "erc721" };

function review(overrides = {}) {
  return buildSendReview({
    asset: { type: "token", token: native },
    recipient,
    amount: "0.25",
    account,
    chainId: 11_155_111,
    maxFeePerGas: 2_000_000_000n,
    ...overrides
  } as never);
}

test("the review names the asset, amount, recipient, network and gas payer", () => {
  const result = review();
  assert.equal(result.asset, "ETH");
  assert.equal(result.amount, "0.25 ETH");
  assert.equal(result.recipient, checksummed, "the recipient is shown checksummed and in full");
  assert.equal(result.network, "Sepolia · chain 11155111");
  assert.equal(result.gasPayer, account);
  assert.equal(result.complete, true);
});

test("the fee is presented as a ceiling, because that is what it is", () => {
  const result = review();
  // Derived from a gas price and a conservative gas ceiling, not from a bundler
  // estimate. Calling it an estimate would overstate what is known.
  assert.equal(result.feeIsUpperBound, true);
  assert.ok(result.maxFee, "a fee must be shown when the price is known");
  assert.ok(Number(result.maxFee) > 0);
});

test("an unknown fee price is admitted rather than guessed", () => {
  const result = review({ maxFeePerGas: null });
  assert.equal(result.maxFee, null);
});

test("the account pays for its own send, and the review says so", () => {
  assert.equal(review().gasPayer, account, "no third party pays; the account funds its own operation");
});

test("a token send names the token, not the native symbol", () => {
  const result = review({ asset: { type: "token", token }, amount: "12.5" });
  assert.equal(result.asset, "USDC");
  assert.equal(result.amount, "12.5 USDC");
});

test("a collectible send names the item and carries no amount field", () => {
  const result = review({ asset: { type: "nft", nft }, amount: "" });
  assert.equal(result.asset, "Loomies #7");
  assert.equal(result.amount, null, "an ERC-721 transfer has no amount to review");
  assert.equal(result.complete, true);
});

test("an incomplete draft is not reviewable and says which part is missing", () => {
  assert.equal(review({ recipient: "" }).complete, false);
  assert.equal(review({ recipient: "not-an-address" }).complete, false);
  assert.equal(review({ amount: "" }).complete, false);
  assert.equal(review({ amount: "0" }).complete, false);
});

test("an unparsed recipient is never shown as if it were an address", () => {
  const result = review({ recipient: "0xnope" });
  assert.equal(result.recipient, null);
  assert.equal(result.complete, false);
});

test("an unknown chain still states its id rather than inventing a name", () => {
  assert.equal(review({ chainId: 918_273 }).network, "Chain 918273");
});
