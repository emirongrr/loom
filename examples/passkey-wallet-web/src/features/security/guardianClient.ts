import type { Address, Hex } from "@loom/core";
import { createGuardianRecoveryClient, type GuardianRecoveryStateTransport, type GuardianSubmitTransport } from "@loom/sdk/recovery";
import { keccak256, toHex } from "viem";
import type { NetworkConfig } from "../../config/network";
import type { PublicClientRegistry } from "../../services/rpc/publicClients";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

export type GuardianClient = ReturnType<typeof createGuardianRecoveryClient>;
type StateBlockTag = "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;

/**
 * A guardian client bound to one account over the user's chosen RPC. The SDK's
 * RPC state transport has no block-timestamp reader, so one is supplied here:
 * without it the client cannot tell a delay that is still running from one that
 * is ready, and the UI would have to guess.
 */
export function createAccountGuardianClient(input: {
  config: NetworkConfig;
  chainId: number;
  account: Address;
  recoveryManager: Address;
  publicClients: PublicClientRegistry;
  recoveryValidatorProvisioner?: WalletDeployment["recoveryValidatorProvisioner"];
  policyHook?: Address;
  submitTransport?: GuardianSubmitTransport;
}): GuardianClient {
  const client = input.publicClients.forEndpoint(input.config.rpcUrl);
  const stateTransport: GuardianRecoveryStateTransport = Object.freeze({
    async ethCall({ to, data, blockTag }: { to: Hex; data: Hex; blockTag?: StateBlockTag }) {
      return client.request({ method: "eth_call", params: [{ to, data }, rpcBlockTag(blockTag)] });
    },
    async getCode({ address, blockTag }: { address: Hex; blockTag?: StateBlockTag }) {
      return client.request({ method: "eth_getCode", params: [address, rpcBlockTag(blockTag)] });
    },
    async getBlockTimestamp() {
      return (await client.getBlock()).timestamp;
    }
  });
  return createGuardianRecoveryClient({
    chainId: input.chainId,
    account: input.account,
    recoveryManager: input.recoveryManager,
    stateTransport,
    ...(input.submitTransport ? { submitTransport: input.submitTransport } : {}),
    ...(input.recoveryValidatorProvisioner && input.policyHook ? {
      recoveryValidatorFactory: {
        ...input.recoveryValidatorProvisioner,
        allowedPolicyHooks: [input.policyHook]
      }
    } : {})
  });
}

/**
 * The verifier's runtime code hash, read from the chain. The deployment manifest
 * for this example pins verifier addresses but not their code hashes, so the
 * hash is read here and the SDK re-checks it against the same chain before the
 * guardian is used. That catches a verifier whose code changed between setup and
 * use, but it does not substitute for a manifest that pins the expected hash.
 */
export async function readVerifierCodeHash(config: NetworkConfig, verifier: Address, publicClients: PublicClientRegistry): Promise<Hex> {
  const client = publicClients.forEndpoint(config.rpcUrl);
  const code = await client.getCode({ address: verifier });
  if (!code || code === "0x") throw new Error("The guardian verifier has no code on this network.");
  return keccak256(code);
}

function rpcBlockTag(blockTag: StateBlockTag | undefined): "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` {
  if (blockTag === undefined) return "latest";
  if (typeof blockTag === "bigint" || typeof blockTag === "number") return toHex(blockTag);
  return blockTag;
}
