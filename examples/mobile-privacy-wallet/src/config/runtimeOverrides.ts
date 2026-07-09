import { MobileWalletConfigurationError } from "../platform/errors";
import type { SecureLocalStore } from "../platform/secureStore";
import type { MobileWalletConfiguration } from "../types/wallet";

// Runtime infrastructure overrides.
//
// The build-time environment stays the source of truth for chain identity,
// addresses, and passkey binding — those must never be editable at runtime.
// Endpoints are different: RPC and bundler URLs are replaceable transports by
// design (any ERC-4337 bundler can be plugged in), so the settings screen may
// override them. Overrides never weaken a gate: an empty override falls back
// to the environment value, and an invalid URL is rejected before it is saved.

export interface EndpointOverrides {
  readonly bundlerUrl?: string;
  readonly rpcUrl?: string;
}

export function assertEndpointUrl(value: string, label: string): string {
  const trimmed = value.trim();
  const parsed = (() => {
    try {
      return new URL(trimmed);
    } catch {
      throw new MobileWalletConfigurationError(`${label} is not a valid URL.`);
    }
  })();
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new MobileWalletConfigurationError(`${label} must be https or localhost.`);
  }
  return trimmed;
}

export async function loadEndpointOverrides(store: SecureLocalStore): Promise<EndpointOverrides> {
  const [bundlerUrl, rpcUrl] = await Promise.all([
    store.get("loom.endpoints.bundler"),
    store.get("loom.endpoints.rpc")
  ]);
  return {
    bundlerUrl: bundlerUrl ?? undefined,
    rpcUrl: rpcUrl ?? undefined
  };
}

export async function saveEndpointOverride(
  store: SecureLocalStore,
  endpoint: "bundler" | "rpc",
  value: string
): Promise<void> {
  const key = endpoint === "bundler" ? "loom.endpoints.bundler" : "loom.endpoints.rpc";
  if (value.trim().length === 0) {
    await store.delete(key);
    return;
  }
  await store.set(key, assertEndpointUrl(value, endpoint === "bundler" ? "Bundler URL" : "RPC URL"));
}

export function applyEndpointOverrides(
  config: MobileWalletConfiguration,
  overrides: EndpointOverrides
): MobileWalletConfiguration {
  if (!overrides.bundlerUrl && !overrides.rpcUrl) {
    return config;
  }
  return {
    ...config,
    network: {
      ...config.network,
      bundlerUrl: overrides.bundlerUrl ?? config.network.bundlerUrl,
      rpcUrl: overrides.rpcUrl ?? config.network.rpcUrl
    }
  };
}
