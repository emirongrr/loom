import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "@loom/core";
import { AppError } from "../src/domain/errors/appError.ts";
import { acquireAccountOperation } from "../src/services/loom/operationGuard.ts";

const ACCOUNT_ID = "11155111:wallet";
const HASH = `0x${"11".repeat(32)}` as Hex;

test("a persisted unconfirmed operation blocks a duplicate submission after reload", async () => {
  const store = {
    list: async () => [{ accountId: ACCOUNT_ID, userOperationHash: HASH, submittedAt: 1 }],
    save: async () => undefined,
    complete: async () => undefined
  };
  await assert.rejects(
    acquireAccountOperation(ACCOUNT_ID, store),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_IN_PROGRESS"
  );
});

test("the account operation lock is released explicitly", async () => {
  const store = { list: async () => [], save: async () => undefined, complete: async () => undefined };
  const release = await acquireAccountOperation(ACCOUNT_ID, store);
  await assert.rejects(acquireAccountOperation(ACCOUNT_ID, store), AppError);
  release();
  const releaseAgain = await acquireAccountOperation(ACCOUNT_ID, store);
  releaseAgain();
});
