import type { Address, Hex } from "@loom/core";
import { createRpcStateTransport } from "@loom/sdk";
import { createGuardianRecoveryClient, type GuardianRecoveryStateTransport, type GuardianSubmitTransport } from "@loom/sdk/recovery";
import { createPublicClient, http, keccak256 } from "viem";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

export type GuardianClient = ReturnType<typeof createGuardianRecoveryClient>;

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
  recoveryValidatorProvisioner?: WalletDeployment["recoveryValidatorProvisioner"];
  policyHook?: Address;
  submitTransport?: GuardianSubmitTransport;
}): GuardianClient {
  const rpc = createRpcStateTransport({ endpoint: input.config.rpcUrl });
  const viemClient = createPublicClient({ transport: http(input.config.rpcUrl) });
  // The guardian client needs getCode to check verifier and account code; the
  // SDK's RPC transport always provides it, so a missing one is a broken build
  // rather than a runtime condition to paper over.
  const getCode = rpc.getCode?.bind(rpc);
  if (!getCode) throw new Error("The RPC state transport does not support code reads.");
  const stateTransport: GuardianRecoveryStateTransport = Object.freeze({
    ethCall: rpc.ethCall.bind(rpc),
    getCode,
    async getBlockTimestamp() {
      return (await viemClient.getBlock()).timestamp;
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
export async function readVerifierCodeHash(config: NetworkConfig, verifier: Address): Promise<Hex> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const code = await client.getCode({ address: verifier });
  if (!code || code === "0x") throw new Error("The guardian verifier has no code on this network.");
  return keccak256(code);
}
