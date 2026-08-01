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
