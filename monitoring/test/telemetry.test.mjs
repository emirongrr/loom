import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { withSpan } from "../src/telemetry.mjs";

test("withSpan is a no-op that runs the function when no provider is registered", async () => {
  trace.disable(); // ensure the global provider is the no-op
  const result = await withSpan("no-op-span", { a: 1 }, () => 42);
  assert.equal(result, 42);
});

test("withSpan records a span and OK status through a registered provider", async () => {
  const spans = [];
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startSpan(name, options) {
        const record = { name, attributes: options?.attributes, status: "unset", ended: false };
        spans.push(record);
        return {
          setStatus: s => (record.status = s.code === 1 ? "ok" : "error"),
          recordException: () => (record.exception = true),
          end: () => (record.ended = true)
        };
      }
    })
  });

  const value = await withSpan("work", { chain_id: "1" }, () => "done");
  assert.equal(value, "done");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "work");
  assert.equal(spans[0].attributes.chain_id, "1");
  assert.equal(spans[0].status, "ok");
  assert.equal(spans[0].ended, true);

  // On throw, the span is marked an error and the original error propagates.
  await assert.rejects(
    withSpan("boom", {}, () => {
      throw new Error("kaboom");
    }),
    /kaboom/
  );
  const failing = spans.find(s => s.name === "boom");
  assert.equal(failing.status, "error");
  assert.equal(failing.exception, true);
  assert.equal(failing.ended, true);

  trace.disable();
});
