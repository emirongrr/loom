// Optional OpenTelemetry OTLP bootstrap.
//
// The component instruments with `@opentelemetry/api` (a zero-dependency
// interface package), so spans and metrics exist whether or not an exporter is
// wired. Full OTLP export — the SDK plus HTTP exporters that push to a Collector
// (which fans out to Prometheus, Tempo/Jaeger, and Loki) — is a heavier tree, so
// it stays an operator-installed opt-in rather than a committed dependency.
//
// Enable it by installing the SDK and setting the endpoint:
//
//   npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \
//         @opentelemetry/exporter-metrics-otlp-http @opentelemetry/resources \
//         @opentelemetry/semantic-conventions
//   LOOM_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node monitoring/server.mjs
//
// Without the endpoint (or the packages), this is a no-op and the built-in
// Prometheus `/metrics` endpoint remains the metrics path.

export async function startOtelIfConfigured() {
  const endpoint = process.env.LOOM_OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return { enabled: false, reason: "LOOM_OTEL_EXPORTER_OTLP_ENDPOINT not set" };

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions")
    ]);
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.LOOM_OTEL_SERVICE_NAME ?? "loom-monitoring" }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
    });
    sdk.start();
    return { enabled: true, endpoint };
  } catch (error) {
    // The packages are not installed; instrumentation stays a no-op.
    return { enabled: false, reason: `OTLP packages unavailable: ${error.message}` };
  }
}
