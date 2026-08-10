import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain/errors/appError.ts";
import { operationFailureStage, operationIsPending, reduceOperationState, type OperationState } from "../src/domain/operations/operationState.ts";

const HASH = `0x${"11".repeat(32)}` as const;
const TX = `0x${"22".repeat(32)}` as const;

test("operation state represents the complete UserOperation lifecycle", () => {
  let state: OperationState = { status: "idle" };
  for (const event of [
    { type: "VALIDATE" }, { type: "PREPARE" }, { type: "ESTIMATE" },
    { type: "REQUEST_PASSKEY" }, { type: "SIGN" }, { type: "SUBMIT" }
  ] as const) {
    state = reduceOperationState(state, event);
    assert.equal(operationIsPending(state), true);
  }
  state = reduceOperationState(state, { type: "CONFIRM", userOperationHash: HASH });
  assert.deepEqual(state, { status: "confirming", userOperationHash: HASH });
  state = reduceOperationState(state, { type: "SUCCEED", userOperationHash: HASH, transactionHash: TX });
  assert.equal(operationIsPending(state), false);
});

test("operation failure retains the submitted hash for safe retry guidance", () => {
  const error = new AppError({ code: "USER_OPERATION_TIMEOUT", userMessage: "Still confirming.", retryable: true, stage: "confirmation" });
  const state = reduceOperationState({ status: "submitting" }, { type: "FAIL", error, userOperationHash: HASH });
  assert.deepEqual(state, { status: "error", error, userOperationHash: HASH });
});

test("operation state rejects impossible success and duplicate submission transitions", () => {
  assert.throws(() => reduceOperationState({ status: "idle" }, {
    type: "SUCCEED",
    userOperationHash: HASH,
    transactionHash: TX
  }));
  assert.throws(() => reduceOperationState({ status: "submitting" }, { type: "SUBMIT" }));
});

test("operation failures preserve the stage that actually failed", () => {
  assert.equal(operationFailureStage({ status: "estimating" }), "estimation");
  assert.equal(operationFailureStage({ status: "awaiting-passkey" }), "passkey");
  assert.equal(operationFailureStage({ status: "signing" }), "passkey");
  assert.equal(operationFailureStage({ status: "submitting" }), "submission");
  assert.equal(operationFailureStage({ status: "confirming", userOperationHash: HASH }), "confirmation");
});
