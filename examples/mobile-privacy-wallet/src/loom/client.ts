import {
  createBundlerTransport,
  createLoomClient,
  type LoomClient,
  type LoomStateReadTransport
} from "@loom/sdk";

import { MobileWalletConfigurationError } from "../platform/errors";
import type { Hex, MobileWalletConfiguration } from "../types/wallet";

export function createExplicitBundlerTransport(config: MobileWalletConfiguration) {
  return config.network.bundlerUrl && config.network.entryPoint
    ? createBundlerTransport({
        endpoint: config.network.bundlerUrl,
        entryPoint: config.network.entryPoint
      })
    : undefined;
}

// State transports are never constructed here. They must come from
// createMobileStateTransport so every read path carries its verification
// label (Helios-verified or explicitly unverified RPC); building a raw RPC
// transport in the client would silently drop that label.
export function createConfiguredLoomClient(input: {
  config: MobileWalletConfiguration;
  account: Hex;
  stateTransport?: LoomStateReadTransport;
}): LoomClient {
  return createLoomClient({
    account: input.account,
    chainId: input.config.network.chainId,
    transport: createExplicitBundlerTransport(input.config),
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
