import assert from "node:assert/strict";
import test from "node:test";
import { parseScannedRecipient } from "../src/features/wallet/scannedRecipient.ts";

const lowercase = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const chainId = 11_155_111;

const scan = (value: string) => parseScannedRecipient(value, { chainId });

test("a bare address is accepted and checksummed", () => {
  const result = scan(lowercase);
  assert.equal(result.kind, "address");
  assert.equal(result.address, checksummed);
});

test("surrounding whitespace from a scan is tolerated", () => {
  assert.equal(scan(`  ${lowercase}\n`).kind, "address");
});

test("an EIP-681 URI for this chain is accepted", () => {
  const result = scan(`ethereum:${lowercase}@${chainId}`);
  assert.equal(result.kind, "address");
  assert.equal(result.address, checksummed);
});

test("an EIP-681 URI without a chain is accepted, like a bare address", () => {
  assert.equal(scan(`ethereum:${lowercase}`).kind, "address");
});

test("an EIP-681 URI for another chain is refused, not silently used", () => {
  // Silently accepting would move the address onto a network the sender never
  // chose, which is the one receive mistake that is usually unrecoverable.
  const result = scan(`ethereum:${lowercase}@1`);
  assert.equal(result.kind, "rejected");
  assert.match(result.reason, /another network|chain/iu);
});

test("a token-transfer request is refused rather than reduced to its address", () => {
  // Honouring only the address would drop the asset and amount the code asked
  // for, and send the wrong thing from a screen that looked like it understood.
  const result = scan(`ethereum:${lowercase}@${chainId}/transfer?address=${lowercase}&uint256=1`);
  assert.equal(result.kind, "rejected");
  assert.match(result.reason, /token transfer|cannot/iu);
});

test("anything that is not an address is refused", () => {
  for (const value of ["", "hello", "0xnope", "https://example.com", "ethereum:not-an-address"]) {
    assert.equal(scan(value).kind, "rejected", `accepted ${value}`);
  }
});

test("an oversized payload is refused before it is parsed", () => {
  const result = scan("0x".padEnd(5000, "a"));
  assert.equal(result.kind, "rejected");
});

test("a refusal never echoes the payload back", () => {
  const hostile = `ethereum:${lowercase}@1`;
  const result = scan(hostile);
  assert.equal(result.kind, "rejected");
  assert.ok(!result.reason.includes(lowercase), "the scanned value must not be reflected into the message");
});
