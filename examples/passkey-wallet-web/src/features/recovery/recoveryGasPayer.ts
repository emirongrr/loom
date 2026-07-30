import type { Hex } from "@loom/core";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { submitAccountCalls, SendResult } from "../wallet/accountClient";
import type { PreparedRecoveryPasskey } from "./recoveryPasskey";

type RecoveryDeploymentCall = NonNullable<PreparedRecoveryPasskey["deploy"]>;

export function recoveryGasPayers(
  accounts: readonly AccountHandle[],
  chainId: number,
  recoveryAccount: string
): readonly AccountHandle[] {
  return Object.freeze(accounts.filter(account =>
    account.chainId === chainId
    && account.account.toLowerCase() !== recoveryAccount.toLowerCase()
  ));
}

export function selectRecoveryGasPayer(
  candidates: readonly AccountHandle[],
  preferredId?: string
): AccountHandle | undefined {
  return candidates.find(candidate => candidate.id === preferredId) ?? candidates[0];
}

/**
 * Publish the exact permissionless validator-factory call through another Loom
 * account. The payer signs only this zero-value call and receives no authority
 * over the account being recovered.
 */
export async function publishRecoveryValidatorWithLoomWallet(input: {
  readonly config: NetworkConfig;
  readonly payer: AccountHandle;
  readonly recoveryAccount: string;
  readonly deployment: WalletDeployment;
  readonly deploy: RecoveryDeploymentCall;
  readonly readCode: (address: AccountHandle["account"]) => Promise<Hex | undefined>;
  readonly submit: typeof submitAccountCalls;
}): Promise<SendResult> {
  if (input.payer.chainId !== input.deployment.chainId) {
    throw new Error("The selected Loom wallet is on a different chain.");
  }
  if (input.payer.account.toLowerCase() === input.recoveryAccount.toLowerCase()) {
    throw new Error("Choose another Loom wallet to pay the recovery factory gas.");
  }
  if (!input.deploy.permissionless || input.deploy.value !== 0n) {
    throw new Error("Recovery validator publication must be the reviewed permissionless zero-value call.");
  }
  const code = await input.readCode(input.payer.account);
  if (!code || code === "0x") {
    throw new Error("The selected Loom wallet is not deployed on chain. Activate it before using it to pay gas.");
  }
  return input.submit({
    config: input.config,
    account: input.payer,
    deployment: input.deployment,
    calls: [{ target: input.deploy.to, data: input.deploy.data, value: 0n }]
  });
}
