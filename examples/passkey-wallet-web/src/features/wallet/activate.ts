import type { Address, Hex } from "@loom/core";
import { encodeCreateAccountCall } from "@loom/core";
import { createBundlerTransport, createLoomClient, createPasskeySigner, createRpcStateTransport } from "@loom/sdk";
import { resolveCreationConfig, type WalletDeployment } from "../onboarding/accountLifecycle.ts";
import { signWithBrowserPasskey } from "./webauthn.ts";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";
import type { SendResult } from "./accountClient";
import { AppError } from "../../domain/errors/appError.ts";
import { confirmUserOperationReceipt } from "../../services/loom/operationReceipt.ts";
import type { PendingOperationStore } from "../../storage/pendingOperations";
import type { RuntimeVerifier } from "../../services/runtime/runtimeVerifier.ts";
import type { PublicClientRegistry } from "../../services/rpc/publicClients.ts";
import { acquireAccountOperation } from "../../services/loom/operationGuard.ts";
import { reconcilePendingOperations } from "../../services/loom/pendingConfirmation.ts";
import { authorizeSponsoredActivation, createSponsoredActivationTransport } from "./sponsoredActivation.ts";

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
  readonly salt: Hex;
  readonly recoveryStatus: "guardian-protected" | "unprotected";
}

const ZERO_ROOT = `0x${"00".repeat(32)}`;

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
    factoryData: encodeCreateAccountCall(account.accountHandle, config),
    salt: account.accountHandle,
    // Stated honestly for the review text: a new account starts with no guardian
    // root, so losing the passkey before guardians are added loses the account.
    recoveryStatus: config.guardianRoot === ZERO_ROOT ? "unprotected" : "guardian-protected"
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
  pendingOperations: PendingOperationStore;
  runtime: RuntimeVerifier;
  publicClients: PublicClientRegistry;
  /** Sponsored onboarding is opt-in and must be advertised by the deployment profile. */
  submission?: "public-self-funded" | "sponsored-private";
}): Promise<SendResult> {
  const { config, account, deployment } = input;
  const plan = planActivation(account, deployment);
  let release: (() => void) | undefined;

  try {
    await input.runtime.verify(config, deployment);
    await reconcilePendingOperations({
      config,
      account,
      store: input.pendingOperations,
      entryPoint: deployment.entryPoint,
      publicClient: input.publicClients.forEndpoint(config.rpcUrl),
      verificationPublicClient: input.publicClients.forEndpoint(config.verificationRpcUrl)
    });
    release = await acquireAccountOperation(account.id, input.pendingOperations);

  const signer = createPasskeySigner({
    credentialId: account.credentialId,
    rpId: account.rpId,
    origin: account.origin,
    validator: deployment.validator,
    entryPoint: deployment.entryPoint,
    signChallenge: signWithBrowserPasskey
  });

  const publicTransport = createBundlerTransport({ endpoint: config.bundlerUrl, entryPoint: deployment.entryPoint });
  const transport = input.submission === "sponsored-private"
    ? createSponsoredActivationTransport({
      endpoint: config.relayUrl,
      account: account.account,
      plan,
      deployment,
      publicTransport
    })
    : publicTransport;
  const client = createLoomClient({
    chainId: account.chainId,
    account: account.account,
    transport,
    stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
    signer
  });

  // This operation carries no calls — it exists to bring the account into being —
  // so it is built from the deployment intent rather than from a call list.
  //
  // `callData` is pinned empty on purpose: the envelope builder falls back to the
  // intent's `initCode` for call data when none is given, which would make the
  // account execute its own creation call as its first action.
  const prepared = client.prepareDeployAccount({
    factory: plan.factory,
    salt: plan.salt,
    initCode: plan.factoryData,
    recoveryStatus: plan.recoveryStatus
  });
  let filled = await client.fillUserOperation(prepared, {
    // A counterfactual account has never acted, so its EntryPoint nonce is zero.
    nonce: 0n,
    callData: "0x",
    factory: plan.factory,
    factoryData: plan.factoryData
  });

  if (input.submission === "sponsored-private") {
    filled = await authorizeSponsoredActivation({ endpoint: config.relayUrl, envelope: filled, deployment });
  }

  const signature = await signer.signUserOperation(filled);
  const signed = { ...filled, userOperation: { ...filled.userOperation, signature } };

  const sent = await transport.sendUserOperation(signed);
  await input.pendingOperations.save({ accountId: account.id, userOperationHash: sent.userOpHash, submittedAt: Date.now() });
  if (!transport.waitForUserOperationReceipt) {
    throw new AppError({
      code: "BUNDLER_UNAVAILABLE",
      userMessage: "The bundler cannot confirm account activation.",
      diagnostic: "receipt polling unavailable",
      retryable: true,
      stage: "confirmation"
    });
  }
  const receipt = await transport.waitForUserOperationReceipt({ userOpHash: sent.userOpHash });
  const transactionHash = await confirmUserOperationReceipt({
    receipt,
    expectedUserOperationHash: sent.userOpHash,
    expectedSender: account.account,
    entryPoint: deployment.entryPoint,
    publicClient: input.publicClients.forEndpoint(config.rpcUrl),
    verificationPublicClient: input.publicClients.forEndpoint(config.verificationRpcUrl)
  });
  await input.pendingOperations.complete(account.id, sent.userOpHash);
  return { userOpHash: sent.userOpHash, transactionHash };
  } finally {
    release?.();
  }
}
