import {
  createBundlerTransport,
  createLoomClient,
  type LoomClient,
  type LoomStateReadTransport,
  type LoomTransportAdapter
} from "@loom/sdk";

import { MobileWalletConfigurationError } from "../platform/errors";
import type { Hex, MobileWalletConfiguration } from "../types/wallet";

export function createExplicitBundlerTransport(config: MobileWalletConfiguration) {
  return config.network.bundlerUrl && config.network.entryPoint
    ? createBundlerTransport({
        endpoint: config.network.bundlerUrl,
        entryPoint: config.network.entryPoint,
        fetch: config.transportFetch
      })
    : undefined;
}

// State transports are never constructed here. They must come from
// createMobileStateTransport so every read path carries its verification
// label (Helios-verified or explicitly unverified RPC); building a raw RPC
// transport in the client would silently drop that label.
//
// config.transport is an explicit escape hatch: a fork can supply its own
// LoomTransportAdapter (for example one that routes bundler submission
// through a proxy, VPN, or Tor-aware fetch) instead of the default bundler
// transport built from EXPO_PUBLIC_LOOM_BUNDLER_URL. It must take priority
// over the auto-built transport, or the override would be silently dropped.
export function resolveBundlerTransport(config: MobileWalletConfiguration): LoomTransportAdapter | undefined {
  return config.transport ?? createExplicitBundlerTransport(config);
}

export function createConfiguredLoomClient(input: {
  config: MobileWalletConfiguration;
  account: Hex;
  stateTransport?: LoomStateReadTransport;
}): LoomClient {
  return createLoomClient({
    account: input.account,
    chainId: input.config.network.chainId,
    transport: resolveBundlerTransport(input.config),
    stateTransport: input.stateTransport ?? input.config.stateTransport
  });
}

export function requireAccountDeploymentConfig(config: MobileWalletConfiguration) {
  if (!config.deployment.accountFactory || !config.deployment.passkeyValidator) {
    throw new MobileWalletConfigurationError("Account deployment configuration is incomplete.", {
      requires: ["accountFactory", "passkeyValidator"]
    });
  }
  if (!config.network.entryPoint) {
    throw new MobileWalletConfigurationError("EntryPoint address is required before account deployment.");
  }
  return {
    factory: config.deployment.accountFactory,
    passkeyValidator: config.deployment.passkeyValidator,
    entryPoint: config.network.entryPoint
  };
}
