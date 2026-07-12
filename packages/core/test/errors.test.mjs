import assert from "node:assert/strict";
import test from "node:test";
import { LoomError, isLoomError } from "../dist/index.js";

test("LoomError carries a stable code and defaults", () => {
  const error = new LoomError("BUNDLER_REJECTED", "bundler said no");
  assert.equal(error.name, "LoomError");
  assert.equal(error.code, "BUNDLER_REJECTED");
  assert.equal(error.message, "bundler said no");
  assert.equal(error.safeMessage, "bundler said no");
  assert.equal(error.retryable, false);
  assert.equal(error.remediation, undefined);
  assert.ok(error instanceof Error);
  assert.ok(isLoomError(error));
});

test("safeMessage can differ from the developer message", () => {
  const error = new LoomError("TRANSPORT_FAILED", "GET https://user:pass@rpc.example failed", {
    safeMessage: "transport failed",
    retryable: true,
    remediation: "retry or switch RPC"
  });
  assert.equal(error.safeMessage, "transport failed");
  assert.equal(error.retryable, true);
  assert.equal(error.remediation, "retry or switch RPC");
});

test("details are frozen and cause is preserved", () => {
  const cause = new Error("root");
  const error = new LoomError("RPC_INCONSISTENT", "providers disagree", {
    details: { a: 1 },
    cause
  });
  assert.equal(error.details.a, 1);
  assert.throws(() => {
    error.details.a = 2;
  }, TypeError);
  assert.equal(error.cause, cause);
});

test("isLoomError rejects non-Loom errors", () => {
  assert.equal(isLoomError(new Error("x")), false);
  assert.equal(isLoomError(null), false);
  assert.equal(isLoomError({ code: "TIMEOUT" }), false);
});
