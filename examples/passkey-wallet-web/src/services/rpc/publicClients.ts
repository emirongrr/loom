import { createPublicClient, http, type PublicClient } from "viem";

export interface PublicClientRegistry {
  forEndpoint(endpoint: string): PublicClient;
}

export function createPublicClientRegistry(): PublicClientRegistry {
  const clients = new Map<string, PublicClient>();
  return Object.freeze({
    forEndpoint(endpoint: string): PublicClient {
      const existing = clients.get(endpoint);
      if (existing) return existing;
      // Batched, because the callers here read many addresses at once.
      // Verifying a deployment reads eleven commitments against each of two
      // endpoints; as separate requests that is twenty-two in a burst, which is
      // enough to trip a public endpoint's rate limit and turn a routine check
      // into a wallet that cannot verify anything. Batching sends one request
      // per endpoint instead, and keeps the parallelism that made the check
      // fast in the first place.
      const client = createPublicClient({ transport: http(endpoint, { batch: true }) });
      clients.set(endpoint, client);
      return client;
    }
  });
}
