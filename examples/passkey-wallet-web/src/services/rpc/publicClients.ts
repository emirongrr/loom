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
      const client = createPublicClient({ transport: http(endpoint) });
      clients.set(endpoint, client);
      return client;
    }
  });
}
