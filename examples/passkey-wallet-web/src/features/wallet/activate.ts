import type { Address, Hex } from "@loom/core";
import { encodeCreateAccountCall } from "@loom/core";
import { createBundlerTransport, createLoomClient, createPasskeySigner, createRpcStateTransport } from "@loom/sdk";
import { resolveCreationConfig, type WalletDeployment } from "../onboarding/accountLifecycle.ts";
import { signWithBrowserPasskey } from "./webauthn.ts";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";
import type { SendResult } from "./accountClient";

// A counterfactual account is created by its first operation, which carries the
// factory call. The account pays for that itself: `validateUserOp` forwards the
// EntryPoint's `missingAccountFunds` out of the account's own balance, and the
// address already holds whatever was sent to it before it existed.
//
// This goes through an ordinary public bundler. The factory only refuses callers
// other than the EntryPoint's `SenderCreator`, which is precisely the path the
// EntryPoint uses for factory calls, so nothing about creation requires a
// privileged submitter — verified against the public bundler, which simulates the
// creation and stops only at the prefund when the account holds nothing.
//
// A sponsor relay is therefore optional, and only for an account that cannot pay
// for its own creation.

export interface ActivationPlan {
  readonly factory: Address;
  readonly factoryData: Hex;
}

/**
 * The creation call for this account, rebuilt from its handle.
 *
 * An account address is a commitment to the configuration it was derived from,
 * so the rebuilt configuration is rejected unless it re-derives this account's
 * own address. Creating an account under any other configuration would silently
 * create a different account in the user's name.
 */
export function planActivation(account: AccountHandle, deployment: WalletDeployment): ActivationPlan {
  if (account.kind !== "derived") throw new Error("A recovered account already exists on chain.");
  const config = resolveCreationConfig(account, deployment);
  if (!config) {
    throw new Error("This account's creation configuration could not be reproduced from the saved handle, so it cannot be created safely.");
  }
  return Object.freeze({
    factory: deployment.factory,
    factoryData: encodeCreateAccountCall(account.salt, config)
  });
}

/**
 * Create the account through a public bundler, paid from its own balance. The
 * passkey signs the operation; the bundler carries it and can alter nothing.
 */
export async function activateAccount(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
}): Promise<SendResult> {
  const { config, account, deployment } = input;
  const plan = planActivation(account, deployment);

  const signer = createPasskeySigner({
    credentialId: account.credentialId,
    rpId: account.rpId,
    origin: account.origin,
    validator: deployment.validator,
    entryPoint: deployment.entryPoint,
    signChallenge: signWithBrowserPasskey
  });

  const client = createLoomClient({
    chainId: account.chainId,
    account: account.account,
    transport: createBundlerTransport({ endpoint: config.bundlerUrl, entryPoint: deployment.entryPoint }),
    stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
    signer
  });

  // No calls: this operation exists to bring the account into being. The nonce is
  // zero because the account has never acted, and gas comes from the bundler's
  // own estimation of the creation it is about to simulate.
  const result = await client.sendTransaction({ calls: [] }, { nonce: 0n, factory: plan.factory, factoryData: plan.factoryData });
  const transactionHash = receiptTransactionHash(result.receipt);
  return transactionHash ? { userOpHash: result.userOpHash, transactionHash } : { userOpHash: result.userOpHash };
}

function receiptTransactionHash(receipt: unknown): Hex | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  const value = receipt as { receipt?: { transactionHash?: unknown }; transactionHash?: unknown };
  const hash = value.receipt?.transactionHash ?? value.transactionHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as Hex) : undefined;
}
