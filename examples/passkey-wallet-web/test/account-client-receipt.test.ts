import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "@loom/core";
import type { UserOperationReceipt } from "@loom/sdk";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { EntryPointAbi } from "@loom/core/abi";
import { AppError } from "../src/domain/errors/appError.ts";
import { confirmUserOperationReceipt, validateUserOperationReceipt } from "../src/services/loom/operationReceipt.ts";

const USER_OP_HASH = `0x${"11".repeat(32)}` as Hex;
const TRANSACTION_HASH = `0x${"22".repeat(32)}` as Hex;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const ENTRY_POINT = "0x3333333333333333333333333333333333333333" as Address;

function chainReceipt(overrides: Record<string, unknown> = {}) {
  const event = EntryPointAbi.find(item => item.type === "event" && item.name === "UserOperationEvent")!;
  return {
    transactionHash: TRANSACTION_HASH,
    status: "success",
    logs: [{
      address: ENTRY_POINT,
      topics: encodeEventTopics({ abi: [event], eventName: "UserOperationEvent", args: {
        userOpHash: USER_OP_HASH,
        sender: ACCOUNT,
        paymaster: "0x0000000000000000000000000000000000000000"
      } }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
        [0n, true, 1n, 1n]
      )
    }],
    ...overrides
  };
}

test("a successful receipt is accepted only with matching provenance", () => {
  const receipt: UserOperationReceipt = {
    userOpHash: USER_OP_HASH,
    success: true,
    sender: ACCOUNT,
    receipt: { transactionHash: TRANSACTION_HASH }
  };
  assert.equal(validateUserOperationReceipt(receipt, USER_OP_HASH, ACCOUNT), TRANSACTION_HASH);
});

test("a reverted UserOperation is never mapped to success", () => {
  const receipt: UserOperationReceipt = {
    userOpHash: USER_OP_HASH,
    success: false,
    sender: ACCOUNT,
    reason: "AA23 reverted",
    receipt: { transactionHash: TRANSACTION_HASH }
  };
  assert.throws(
    () => validateUserOperationReceipt(receipt, USER_OP_HASH, ACCOUNT),
    (error: unknown) => error instanceof AppError && error.code === "TRANSACTION_REVERTED"
  );
});

test("a receipt for another sender is rejected", () => {
  const receipt: UserOperationReceipt = {
    userOpHash: USER_OP_HASH,
    success: true,
    sender: "0x2222222222222222222222222222222222222222",
    receipt: { transactionHash: TRANSACTION_HASH }
  };
  assert.throws(
    () => validateUserOperationReceipt(receipt, USER_OP_HASH, ACCOUNT),
    (error: unknown) => error instanceof AppError && error.code === "USER_OPERATION_REJECTED"
  );
});

test("success without a transaction hash is rejected", () => {
  const receipt: UserOperationReceipt = { userOpHash: USER_OP_HASH, success: true, sender: ACCOUNT };
  assert.throws(
    () => validateUserOperationReceipt(receipt, USER_OP_HASH, ACCOUNT),
    (error: unknown) => error instanceof AppError && error.code === "USER_OPERATION_REJECTED"
  );
});

test("bundler success is accepted only when the EntryPoint event independently proves it", async () => {
  const receipt: UserOperationReceipt = { userOpHash: USER_OP_HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TRANSACTION_HASH } };
  const publicClient = { getTransactionReceipt: async () => chainReceipt() };
  assert.equal(await confirmUserOperationReceipt({ receipt, expectedUserOperationHash: USER_OP_HASH, expectedSender: ACCOUNT, entryPoint: ENTRY_POINT, publicClient: publicClient as never, verificationPublicClient: publicClient as never }), TRANSACTION_HASH);
});

test("a bundler success claim without a matching EntryPoint event is rejected", async () => {
  const receipt: UserOperationReceipt = { userOpHash: USER_OP_HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TRANSACTION_HASH } };
  const publicClient = { getTransactionReceipt: async () => chainReceipt({ logs: [] }) };
  await assert.rejects(
    confirmUserOperationReceipt({ receipt, expectedUserOperationHash: USER_OP_HASH, expectedSender: ACCOUNT, entryPoint: ENTRY_POINT, publicClient: publicClient as never, verificationPublicClient: publicClient as never }),
    (error: unknown) => error instanceof AppError && error.code === "USER_OPERATION_REJECTED"
  );
});

test("a reverted chain transaction is rejected even when the bundler claims success", async () => {
  const receipt: UserOperationReceipt = { userOpHash: USER_OP_HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TRANSACTION_HASH } };
  const publicClient = { getTransactionReceipt: async () => chainReceipt({ status: "reverted" }) };
  await assert.rejects(
    confirmUserOperationReceipt({ receipt, expectedUserOperationHash: USER_OP_HASH, expectedSender: ACCOUNT, entryPoint: ENTRY_POINT, publicClient: publicClient as never, verificationPublicClient: publicClient as never }),
    (error: unknown) => error instanceof AppError && error.code === "TRANSACTION_REVERTED"
  );
});

test("receipt confirmation rejects disagreement between independent RPCs", async () => {
  const receipt: UserOperationReceipt = { userOpHash: USER_OP_HASH, success: true, sender: ACCOUNT, receipt: { transactionHash: TRANSACTION_HASH } };
  const primary = { getTransactionReceipt: async () => chainReceipt() };
  const verifierClient = { getTransactionReceipt: async () => chainReceipt({ logs: [] }) };
  await assert.rejects(confirmUserOperationReceipt({ receipt, expectedUserOperationHash: USER_OP_HASH, expectedSender: ACCOUNT, entryPoint: ENTRY_POINT, publicClient: primary as never, verificationPublicClient: verifierClient as never }), AppError);
});
