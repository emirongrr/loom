import assert from "node:assert/strict";
import test from "node:test";
import { AppError, normalizeAppError, safeUserMessage } from "../src/domain/errors/appError.ts";

test("WebAuthn cancellation becomes a retryable safe error", () => {
  const issue = new Error("User closed prompt"); issue.name = "NotAllowedError";
  const error = normalizeAppError(issue, "passkey");
  assert.equal(error.code, "PASSKEY_CANCELLED");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.userMessage, /User closed/u);
});

test("diagnostics redact endpoints while preserving a safe user message", () => {
  const error = normalizeAppError(new Error("request failed https://rpc.example/key?token=secret"), "submission");
  assert.equal(error.code, "UNKNOWN");
  assert.match(error.diagnostic, /endpoint redacted/u);
  assert.doesNotMatch(error.diagnostic, /secret/u);
});

test("an existing AppError is not reclassified", () => {
  const expected = new AppError({ code: "INVALID_INPUT", userMessage: "Check the form.", retryable: true, stage: "validation" });
  assert.equal(normalizeAppError(expected, "submission"), expected);
});

test("unknown infrastructure diagnostics never become the visible message", () => {
  const issue = new Error("RPC failed at https://secret.example with raw payload");
  assert.equal(safeUserMessage(issue, "The account could not be checked.", "configuration"), "The account could not be checked.");
});

test("a bundler RPC rejection keeps a safe actionable classification and diagnostic", () => {
  const issue = Object.assign(new Error("bundler rpc request failed"), {
    name: "InvalidSdkRequestError",
    details: {
      method: "eth_estimateUserOperationGas",
      code: -32500,
      message: "AA21 didn't pay prefund at https://bundler.example/private-token"
    }
  });
  const error = normalizeAppError(issue, "estimation");
  assert.equal(error.code, "USER_OPERATION_REJECTED");
  assert.equal(error.stage, "estimation");
  assert.match(error.userMessage, /gas estimation/u);
  assert.match(error.diagnostic, /AA21/u);
  assert.doesNotMatch(error.diagnostic, /private-token/u);
});
