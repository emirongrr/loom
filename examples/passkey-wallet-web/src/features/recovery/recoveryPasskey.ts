import type { Address, Hex } from "@loom/core";
import { P256ValidatorAbi } from "@loom/core/abi";
import { encodeFunctionData, keccak256, sha256, stringToHex } from "viem";
import type { RegisteredPasskey, WalletDeployment } from "../onboarding/accountLifecycle";

export interface PreparedRecoveryPasskey {
  readonly passkey: RegisteredPasskey;
  readonly rpId: string;
  readonly origin: string;
  readonly initData: Hex;
  readonly validator: Address;
  readonly initDataHash: Hex;
  readonly alreadyDeployed: boolean;
  readonly deploy?: { readonly to: Address; readonly data: Hex; readonly value: 0n; readonly permissionless: true };
}

export interface Eip1193Provider {
  request(input: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
}

/**
 * Create a recovery credential only after the deployment has advertised the
 * immutable factory profile. The caller's prepare callback independently
 * checks that profile against live bytecode and binds the predicted child to
 * this account's current recovery nonce.
 */
export async function prepareNewRecoveryPasskey(input: {
  readonly deployment: WalletDeployment;
  readonly label: string;
  readonly rpId: string;
  readonly origin: string;
  readonly register: (label: string) => Promise<RegisteredPasskey>;
  readonly prepare: (input: { initData: Hex }) => Promise<{
    readonly validator: Address;
    readonly initDataHash: Hex;
    readonly alreadyDeployed: boolean;
    readonly deploy?: { readonly to: Address; readonly data: Hex; readonly value: 0n; readonly permissionless: true };
  }>;
}): Promise<PreparedRecoveryPasskey> {
  if (!input.deployment.recoveryValidatorProvisioner) {
    throw new Error("This deployment cannot provision a recovery passkey validator.");
  }
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error("Give the recovery passkey a name of 1 to 80 characters.");
  const passkey = await input.register(label);
  const initData = encodeRecoveryPasskeyInitData({
    passkey,
    rpId: input.rpId,
    origin: input.origin,
    policyHook: input.deployment.policyHook
  });
  const prepared = await input.prepare({ initData });
  return Object.freeze({ passkey, rpId: input.rpId, origin: input.origin, initData, ...prepared });
}

export function encodeRecoveryPasskeyInitData(input: {
  readonly passkey: RegisteredPasskey;
  readonly rpId: string;
  readonly origin: string;
  readonly policyHook: Address;
}): Hex {
  return encodeFunctionData({
    abi: P256ValidatorAbi,
    functionName: "initialize",
    args: [
      input.passkey.publicKey.x,
      input.passkey.publicKey.y,
      sha256(stringToHex(input.rpId)),
      keccak256(stringToHex(input.origin)),
      input.policyHook
    ]
  });
}

/** Publish only the exact, zero-value factory call prepared by the SDK. */
export async function publishRecoveryValidator(input: {
  readonly provider: Eip1193Provider;
  readonly chainId: number;
  readonly deploy: NonNullable<PreparedRecoveryPasskey["deploy"]>;
}): Promise<Hex> {
  return sendEip1193Transaction({ provider: input.provider, chainId: input.chainId, to: input.deploy.to, data: input.deploy.data, value: input.deploy.value });
}

export async function sendEip1193Transaction(input: {
  readonly provider: Eip1193Provider;
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}): Promise<Hex> {
  const liveChain = await input.provider.request({ method: "eth_chainId" });
  if (typeof liveChain !== "string" || BigInt(liveChain) !== BigInt(input.chainId)) {
    throw new Error(`Switch the publishing wallet to chain ${input.chainId}.`);
  }
  const accounts = await input.provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) {
    throw new Error("No publishing wallet account is available.");
  }
  const hash = await input.provider.request({
    method: "eth_sendTransaction",
    params: [{ from: accounts[0], to: input.to, data: input.data, value: `0x${(input.value ?? 0n).toString(16)}` }]
  });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("The publishing wallet returned an invalid transaction hash.");
  }
  return hash as Hex;
}
