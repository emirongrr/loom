import type { Address, Hex } from "@loom/core";
import { submitAccountCalls, type SendResult } from "../wallet/accountClient";
import { createAccountGuardianClient } from "./guardianClient";
import { MIN_DELAY_SECONDS, planGuardianChange } from "./guardianPlan";
import type { RosterPending } from "../../storage/guardianRosterRecord";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

export interface PendingChangeStatus {
  /** False when the chain holds no such scheduled operation any more. */
  readonly found: boolean;
  /** Unix seconds at which the change may be executed. */
  readonly readyAt: bigint;
  readonly ready: boolean;
  /** The chain's own clock, so the countdown never trusts the device clock. */
  readonly chainTimestamp: bigint;
  readonly prepared: PreparedChange;
}

type PreparedChange = Awaited<ReturnType<ReturnType<typeof createAccountGuardianClient>["prepareGuardianConfiguration"]>>;

/**
 * Re-derive the scheduled operation from the persisted plan and ask the account
 * when it becomes executable.
 *
 * The operation's identity binds the account's configuration version, so a
 * configuration change since scheduling produces a different identity and the
 * chain reports nothing pending. That is the protocol invalidating a stale
 * operation, not an error — it is surfaced as `found: false` rather than as a
 * countdown that would never complete.
 */
export async function readPendingGuardianChange(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
  pending: RosterPending;
}): Promise<PendingChangeStatus> {
  const { config, account, deployment, pending } = input;
  if (!deployment.recoveryModule) throw new Error("This deployment publishes no recovery module.");

  // Salts were persisted with the plan, so this rebuilds the exact same set.
  const { set } = planGuardianChange({ current: [], next: pending.entries, threshold: pending.threshold });
  const client = createAccountGuardianClient({
    config,
    chainId: account.chainId,
    account: account.account,
    recoveryManager: deployment.recoveryModule
  });
  const prepared = await client.prepareGuardianConfiguration({ set, delaySeconds: MIN_DELAY_SECONDS });
  const status = await client.readPendingGuardianConfiguration(prepared);

  return Object.freeze({
    found: status.pending,
    readyAt: status.readyAt,
    ready: status.ready ?? false,
    chainTimestamp: status.chainTimestamp ?? 0n,
    prepared
  });
}

/** Execute a scheduled change once its delay has elapsed. Permissionless on
 * chain, but submitted here through the owner's account like any other call. */
export async function executePendingGuardianChange(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
  prepared: PreparedChange;
}): Promise<SendResult> {
  const call = input.prepared.executeCall;
  return submitAccountCalls({
    config: input.config,
    account: input.account,
    deployment: input.deployment,
    calls: [{ target: call.to as Address, value: 0n, data: call.data as Hex }]
  });
}

/** Cancel a scheduled change before it executes. */
export async function cancelPendingGuardianChange(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
  prepared: PreparedChange;
}): Promise<SendResult> {
  const call = input.prepared.cancelCall;
  return submitAccountCalls({
    config: input.config,
    account: input.account,
    deployment: input.deployment,
    calls: [{ target: call.target as Address, value: 0n, data: call.data as Hex }]
  });
}
