import assert from "node:assert/strict";
import test from "node:test";
import { createReceiveTarget, receiveChainLabel } from "../src/features/wallet/receiveTarget.ts";

const lowercase = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

test("the displayed address is checksummed regardless of how it was stored", () => {
  const target = createReceiveTarget({ address: lowercase, chainId: 11_155_111, deployed: true });
  assert.equal(target.address, checksummed);
});

test("an unusable address is refused rather than shown as a receive target", () => {
  assert.throws(() => createReceiveTarget({ address: "0xnope", chainId: 11_155_111, deployed: true }));
  assert.throws(() => createReceiveTarget({ address: lowercase, chainId: 0, deployed: true }));
});

test("the QR payload is the bare address, which every scanner understands", () => {
  const target = createReceiveTarget({ address: lowercase, chainId: 11_155_111, deployed: true });
  // A chain-bound URI is offered separately: a scanner that does not parse
  // EIP-681 would fail on it, and failing to receive is worse than a plain
  // address beside a clearly labelled network.
  assert.equal(target.qrPayload, checksummed);
});

test("the chain-bound link is a valid EIP-681 pay-to-address URI", () => {
  const target = createReceiveTarget({ address: lowercase, chainId: 11_155_111, deployed: true });
  assert.equal(target.uri, `ethereum:${checksummed}@11155111`);
});

test("a known chain is named and an unknown one still states its id", () => {
  assert.equal(receiveChainLabel(11_155_111), "Sepolia");
  assert.equal(receiveChainLabel(1), "Ethereum");
  assert.equal(receiveChainLabel(918_273), "Chain 918273");
});

test("a counterfactual account is flagged so the sheet can explain it", () => {
  const pending = createReceiveTarget({ address: lowercase, chainId: 11_155_111, deployed: false });
  assert.equal(pending.deployed, false);
  const live = createReceiveTarget({ address: lowercase, chainId: 11_155_111, deployed: true });
  assert.equal(live.deployed, true);
});

test("the target carries the chain id it was built for, never a default", () => {
  const target = createReceiveTarget({ address: lowercase, chainId: 1, deployed: true });
  assert.equal(target.chainId, 1);
  assert.equal(target.chainLabel, "Ethereum");
  assert.equal(target.uri, `ethereum:${checksummed}@1`);
});
