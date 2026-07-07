import {
  createBundlerTransport,
  createLoomClient,
  createRpcStateTransport,
  type LoomClient
} from "@loom/sdk";

import { MobileWalletConfigurationError } from "../platform/errors";
import type { Hex, MobileWalletConfiguration } from "../types/wallet";

export function createExplicitTransports(config: MobileWalletConfiguration) {
  const transport =
    config.network.bundlerUrl && config.network.entryPoint
      ? createBundlerTransport({
          endpoint: config.network.bundlerUrl,
          entryPoint: config.network.entryPoint
        })
      : undefined;

  const stateTransport =
    config.network.rpcUrl && config.verifiedState.mode === "rpc"
      ? createRpcStateTransport({ endpoint: config.network.rpcUrl })
      : config.stateTransport;

  return { transport, stateTransport };
}

export function createConfiguredLoomClient(input: {
  config: MobileWalletConfiguration;
  account: Hex;
}): LoomClient {
  const { transport, stateTransport } = createExplicitTransports(input.config);

  return createLoomClient({
    account: input.account,
    chainId: input.config.network.chainId,
    transport,
    stateTransport
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
