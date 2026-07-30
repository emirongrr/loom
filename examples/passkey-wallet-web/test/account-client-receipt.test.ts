import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "@loom/core";
import type { UserOperationReceipt } from "@loom/sdk";
import { AppError } from "../src/domain/errors/appError.ts";
import { validateUserOperationReceipt } from "../src/services/loom/operationReceipt.ts";

const USER_OP_HASH = `0x${"11".repeat(32)}` as Hex;
const TRANSACTION_HASH = `0x${"22".repeat(32)}` as Hex;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;

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
