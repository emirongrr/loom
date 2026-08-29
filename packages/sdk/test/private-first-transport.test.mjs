import assert from "node:assert/strict";
import test from "node:test";
import { applyPaymasterAuthorization, createPrivateFirstTransport, InvalidSdkRequestError } from "../dist/index.js";

const HASH = `0x${"11".repeat(32)}`;
const envelope = { chainId: 1, account: `0x${"22".repeat(20)}`, intent: { kind: "deploy-account" }, userOperation: {} };

test("private submission is used while public infrastructure supplies estimates and receipts", async () => {
  const calls = [];
  const receipt = { userOpHash: HASH, success: true, receipt: { transactionHash: `0x${"33".repeat(32)}` } };
  const transport = createPrivateFirstTransport({
    privateTransport: { async sendUserOperation() { calls.push("private"); return { userOpHash: HASH, receipt }; } },
    publicTransport: {
      async sendUserOperation() { calls.push("public-send"); return { userOpHash: HASH }; },
      async estimateUserOperationGas() { calls.push("estimate"); return { callGasLimit: 1n, verificationGasLimit: 2n, preVerificationGas: 3n }; },
      async waitForUserOperationReceipt() { calls.push("public-receipt"); throw new Error("private receipt should win"); }
    }
  });
  await transport.estimateUserOperationGas(envelope);
  const sent = await transport.sendUserOperation(envelope);
  assert.equal(await transport.waitForUserOperationReceipt({ userOpHash: sent.userOpHash }), receipt);
  assert.deepEqual(calls, ["estimate", "private"]);
});

test("ambiguous private failures never fall back", async () => {
  let publicCalls = 0;
  const timeout = new Error("request timed out after delivery became unknown");
  const transport = createPrivateFirstTransport({
    privateTransport: { async sendUserOperation() { throw timeout; } },
    publicTransport: { async sendUserOperation() { publicCalls += 1; return { userOpHash: HASH }; } },
    fallback: "explicit-rejection",
    isExplicitRejection: () => false
  });
  await assert.rejects(transport.sendUserOperation(envelope), error => error === timeout);
  assert.equal(publicCalls, 0);
});

test("public fallback requires positive proof of non-acceptance", async () => {
  const rejected = Object.assign(new Error("not accepted"), { safeToFallback: true });
  let publicCalls = 0;
  const transport = createPrivateFirstTransport({
    privateTransport: { async sendUserOperation() { throw rejected; } },
    publicTransport: { async sendUserOperation() { publicCalls += 1; return { userOpHash: HASH }; } },
    fallback: "explicit-rejection",
    isExplicitRejection: error => error?.safeToFallback === true
  });
  assert.equal((await transport.sendUserOperation(envelope)).userOpHash, HASH);
  assert.equal(publicCalls, 1);
});

test("explicit fallback cannot be enabled without a classifier", () => {
  assert.throws(() => createPrivateFirstTransport({
    privateTransport: { async sendUserOperation() { return { userOpHash: HASH }; } },
    publicTransport: { async sendUserOperation() { return { userOpHash: HASH }; } },
    fallback: "explicit-rejection"
  }), InvalidSdkRequestError);
});

test("paymaster authorization is attached before the final account signature", () => {
  const prepared = {
    kind: "userOperation.prepare", chainId: 1, account: `0x${"22".repeat(20)}`,
    intent: { kind: "deploy-account" }, intentHash: `0x${"44".repeat(32)}`, review: {},
    userOperation: {
      sender: `0x${"22".repeat(20)}`, nonce: 0n, callData: "0x",
      callGasLimit: 1n, verificationGasLimit: 2n, preVerificationGas: 3n,
      maxFeePerGas: 4n, maxPriorityFeePerGas: 1n, signature: "0x1234"
    }
  };
  const authorized = applyPaymasterAuthorization(prepared, {
    paymaster: `0x${"55".repeat(20)}`, paymasterVerificationGasLimit: 6n,
    paymasterPostOpGasLimit: 7n, paymasterData: "0xabcd", preVerificationGas: 8n
  });
  assert.equal(authorized.userOperation.paymaster, `0x${"55".repeat(20)}`);
  assert.equal(authorized.userOperation.preVerificationGas, 8n);
  assert.equal(authorized.userOperation.paymasterVerificationGasLimit, 6n);
  assert.throws(() => applyPaymasterAuthorization(prepared, {
    paymaster: `0x${"55".repeat(20)}`, paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 1n, paymasterData: "0xabcd"
  }), InvalidSdkRequestError);
});
