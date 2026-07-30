import type { Address, Hex } from "@loom/core";
import { encodeFunctionData } from "viem";
import { LoomAccountAbi } from "@loom/core/abi";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { createAccountGuardianClient } from "../security/guardianClient";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

export interface FreezePreparation {
  readonly digest: Hex;
  readonly configVersion: bigint;
  readonly nonce: bigint;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly submit: { readonly to: Address; readonly data: Hex };
}

/** Re-read live authority and return the exact digest the guardian must approve. */
export async function prepareGuardianFreezeChallenge(input: {
  config: NetworkConfig;
  deployment: WalletDeployment;
  capability: GuardianInviteV1;
}): Promise<{ readonly digest: Hex }> {
  if (!input.deployment.recoveryModule) throw new Error("This deployment publishes no recovery module.");
  const client = createAccountGuardianClient({
    config: input.config,
    chainId: input.capability.chainId,
    account: input.capability.account,
    recoveryManager: input.deployment.recoveryModule
  });
  const prepared = await client.prepareFreeze(input.capability);
  return Object.freeze({ digest: prepared.digest });
}

/**
 * Prepare an emergency freeze for an account this device holds a capability for.
 *
 * Everything security-relevant happens here and is re-read from the chain rather
 * than trusted from the stored capability: the account's live guardian root and
 * configuration version must still match the capability, recovery must actually
 * be configured, and this guardian must not have already frozen this
 * configuration. A stale or revoked capability fails closed.
 *
 * Freezing is deliberately narrow. It pauses ordinary execution for the
 * contract's window; it moves no funds, approves no recovery, and grants the
 * guardian no spending authority.
 */
export async function prepareGuardianFreeze(input: {
  config: NetworkConfig;
  deployment: WalletDeployment;
  capability: GuardianInviteV1;
  signature: Hex;
}): Promise<FreezePreparation> {
  const { config, deployment, capability, signature } = input;
  if (!deployment.recoveryModule) throw new Error("This deployment publishes no recovery module.");

  const client = createAccountGuardianClient({
    config,
    chainId: capability.chainId,
    account: capability.account,
    recoveryManager: deployment.recoveryModule
  });

  const prepared = await client.prepareFreeze(capability);

  // The verifier contract decides whether this signature authorises the freeze.
  // Checking before submission turns a wasted, publicly visible failed
  // transaction into a local error.
  if (!(await client.verifyFreezeApproval(prepared, signature))) {
    throw new Error("The guardian signature does not authorise this freeze. Check that it signs the exact digest shown.");
  }

  return Object.freeze({
    digest: prepared.digest,
    configVersion: prepared.configVersion,
    nonce: prepared.nonce,
    summary: prepared.review.summary,
    warnings: prepared.review.warnings,
    submit: Object.freeze({
      to: prepared.account,
      // Freezing is permissionless: any submitter can carry this call, and none
      // of them can alter it or gain authority by carrying it.
      data: encodeFunctionData({
        abi: LoomAccountAbi,
        functionName: "freeze",
        args: [prepared.guardian.verifier, prepared.guardian.keyCommitment, prepared.guardian.salt, prepared.proof, signature]
      }) as Hex
    })
  });
}

/** Read the account's live freeze state, so a guardian sees the outcome. */
export async function readFreezeState(input: {
  config: NetworkConfig;
  deployment: WalletDeployment;
  capability: GuardianInviteV1;
}): Promise<{ frozenUntil: bigint; active: boolean; recoveryConfigured: boolean }> {
  if (!input.deployment.recoveryModule) throw new Error("This deployment publishes no recovery module.");
  const client = createAccountGuardianClient({
    config: input.config,
    chainId: input.capability.chainId,
    account: input.capability.account,
    recoveryManager: input.deployment.recoveryModule
  });
  const state = await client.inspectAccount();
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { frozenUntil: state.frozenUntil, active: state.frozenUntil > now, recoveryConfigured: state.recoveryConfigured };
}
