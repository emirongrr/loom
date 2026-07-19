// Instrument an injected RPC function so every call is measured.
//
// Wrapping the operator's `rpc(method, params)` keeps provider observability
// where it belongs — around the transport — without the indexer knowing how the
// endpoint is reached. Each call records a request, an error on failure, and its
// duration, all labelled by provider and method, and re-raises the original
// error unchanged.

export function instrumentRpc(rpc, { metrics, provider = "primary" } = {}) {
  return async function instrumented(method, params) {
    const started = performance.now();
    try {
      const result = await rpc(method, params);
      metrics.recordRpc({ provider, method, ok: true, durationMs: performance.now() - started });
      return result;
    } catch (error) {
      metrics.recordRpc({ provider, method, ok: false, durationMs: performance.now() - started });
      throw error;
    }
  };
}
