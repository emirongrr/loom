import assert from "node:assert/strict";
import test from "node:test";
import { describeCall, summarizeOperation, type AccountOperation } from "../src/features/wallet/userOperationHistory.ts";
import type { WalletDeployment } from "../src/services/deployment/deploymentProfile.ts";

const BOARD = "0x4c0a39a24f84abcb61648e415eecd5ad87ed23bf" as const;
const SELF = "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1" as const;
const STRANGER = "0x1111111111111111111111111111111111111111" as const;

const deployment = {
  chainId: 11155111,
  entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
  factory: "0x74c15bd5f33318360fe273975c2c7c999212dfb7",
  recoveryModule: "0x9569cae60f775341c0f6c8f70170d85adbfab5f8",
  recoveryIntentBoard: BOARD,
  policyHook: "0x2222222222222222222222222222222222222222"
} as unknown as WalletDeployment;

// The announce selector, as the board's own signature produces it.
const ANNOUNCE = "0x2fce29d2" as const;

const operation = (over: Partial<AccountOperation> = {}): AccountOperation => ({
  userOpHash: `0x${"aa".repeat(32)}`,
  transactionHash: `0x${"bb".repeat(32)}`,
  blockNumber: 11538337n,
  nonce: 3n,
  succeeded: true,
  feePaid: 333158138606826n,
  action: { kind: "call", target: BOARD, value: 0n, selector: ANNOUNCE, label: "Recovery board" },
  ...over
} as AccountOperation);

test("a contract the manifest names is named", () => {
  assert.equal(describeCall({ target: BOARD, selector: "0x00000000", deployment, self: SELF }), "Recovery board");
});

test("the account itself is named, so a self-call does not read as a stranger", () => {
  assert.equal(describeCall({ target: SELF, selector: "0x00000000", deployment, self: SELF }), "This account");
});

// The one thing history must not do: invent a name for something the reader
// did not expect, since that is exactly what they open history to find.
test("an unknown contract keeps its address rather than being given a name", () => {
  assert.equal(describeCall({ target: STRANGER, selector: "0x00000000", deployment, self: SELF }), "");
});

test("a reverted operation says the fee was paid anyway", () => {
  const line = summarizeOperation(operation({ succeeded: false }));
  assert.match(line, /reverted/);
  assert.match(line, /fee was still paid/);
});

test("value sent is stated, not left inside the calldata", () => {
  const line = summarizeOperation(operation({
    action: { kind: "call", target: STRANGER, value: 10n ** 17n, selector: "0x00000000", label: "" }
  }));
  assert.match(line, /sent 0\.1 ETH/);
});

test("an unnamed target falls back to its address and selector", () => {
  const line = summarizeOperation(operation({
    action: { kind: "call", target: STRANGER, value: 0n, selector: "0xdeadbeef", label: "" }
  }));
  assert.match(line, /0x11111111/);
  assert.match(line, /0xdeadbeef/);
});

test("account creation reads as creation", () => {
  assert.match(summarizeOperation(operation({ action: { kind: "deployment" } })), /Account created/);
});

// Guessing at an operation that could not be decoded would be worse than
// admitting it: the reader would take the guess for the record.
test("an operation that could not be read says so, with the reason", () => {
  const line = summarizeOperation(operation({
    action: { kind: "unreadable", reason: "submitted through innerHandleOp" }
  }));
  assert.match(line, /innerHandleOp/);
});
