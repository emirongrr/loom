// Tracing via the OpenTelemetry API.
//
// Best practice is to instrument with `@opentelemetry/api` — the interface-only
// package (zero dependencies) — and let the operator wire an exporter. Until a
// TracerProvider is registered (see ./otel.mjs, an optional operator-installed
// bootstrap), every span here is a no-op with no overhead. The component works
// standalone with just its Prometheus endpoint; add OTLP export and the same
// spans flow to a Collector -> Tempo/Jaeger without touching this code.

import { SpanStatusCode, trace } from "@opentelemetry/api";

const TRACER_NAME = "loom.monitoring";

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

// Run `fn` inside a span named `name` with the given attributes. The span is
// closed on return, and recorded as an error (without swallowing it) on throw.
// Async and sync `fn` are both supported.
export async function withSpan(name, attributes, fn) {
  const span = tracer().startSpan(name, { attributes });
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
    throw error;
  } finally {
    span.end();
  }
}

// The canonical low-cardinality attribute keys used across metrics and traces,
// so labels stay consistent between the two signals.
export const ATTR = Object.freeze({
  chainId: "chain_id",
  entryPoint: "entry_point",
  status: "status",
  provider: "provider",
  operationType: "operation_type",
  finalityState: "finality_state",
  method: "method"
});
