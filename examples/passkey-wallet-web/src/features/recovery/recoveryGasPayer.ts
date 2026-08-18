import type { Address, Hex } from "@loom/core";
import { P256RecoveryValidatorFactoryAbi, P256ValidatorAbi } from "@loom/core/abi";
import { decodeFunctionData, encodeFunctionData, keccak256 } from "viem";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { SendResult } from "../wallet/accountClient";
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
  readonly initDataHash: Hex;
  readonly readCode: (address: AccountHandle["account"]) => Promise<Hex | undefined>;
  readonly submit: (input: {
    readonly config: NetworkConfig;
    readonly account: AccountHandle;
    readonly deployment: WalletDeployment;
    readonly calls: readonly { readonly target: `0x${string}`; readonly data: Hex; readonly value: bigint }[];
  }) => Promise<SendResult>;
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
  const provisioner = input.deployment.recoveryValidatorProvisioner;
  if (!provisioner || input.deploy.to.toLowerCase() !== provisioner.address.toLowerCase()) {
    throw new Error("Recovery validator publication does not target the trusted deployment factory.");
  }
  let decoded: { readonly functionName: string; readonly args: readonly unknown[] };
  try { decoded = decodeFunctionData({ abi: P256RecoveryValidatorFactoryAbi, data: input.deploy.data }); }
  catch { throw new Error("Recovery validator publication calldata is invalid."); }
  // The factory now takes the key fields rather than their hash (ADR-0025), so
  // the passkey is bound by re-deriving the commitment from the very bytes this
  // wallet would sign. Comparing a field would only prove the call mentions
  // something familiar; this proves it deploys the reviewed key.
  const keyFields = decoded.args.slice(2, 7);
  const committed = keyFields.length === 5
    ? keccak256(encodeFunctionData({
      abi: P256ValidatorAbi,
      functionName: "initialize",
      args: keyFields as [Hex, Hex, Hex, Hex, Address]
    }))
    : "0x";
  if (
    decoded.functionName !== "deploy"
    || String(decoded.args[0]).toLowerCase() !== input.recoveryAccount.toLowerCase()
    || committed.toLowerCase() !== input.initDataHash.toLowerCase()
  ) throw new Error("Recovery validator publication does not match the reviewed account and passkey.");
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
