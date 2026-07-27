import type { Address, Hex } from "@loom/core";
import { encodeCreateAccountCall, getUserOpHash, packUserOperation } from "@loom/core";
import { createWebAuthnSigner } from "@loom/passkey";
import { createLoomClient } from "@loom/sdk";
import { resolveCreationConfig, type WalletDeployment } from "../onboarding/accountLifecycle";
import { signWithBrowserPasskey } from "./webauthn";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";

// Creating a counterfactual account is the one operation a public bundler cannot
// carry. The factory fail-closes to the EntryPoint's `senderCreator`, so the
// creation operation has to reach `EntryPoint.handleOps` directly, which needs a
// submitter holding gas. The browser has none, so the signed operation is handed
// to a submitter instead.
//
// That submitter gains nothing: the operation is signed by the user's passkey and
// any edit invalidates the signature. It pays for publication, it does not
// acquire authority over the account it publishes.

export interface ActivationPreparation {
  readonly userOpHash: Hex;
  readonly packed: Readonly<Record<string, string>>;
  /** True when the account can cover its own creation from its balance. */
  readonly selfFunded: boolean;
}

export interface ActivationResult {
  readonly account: Address;
  readonly transactionHash?: Hex;
  readonly alreadyDeployed: boolean;
}

const CREATION_GAS = Object.freeze({
  callGasLimit: 500_000n,
  // Creation plus one P-256 verification; the passkey signer's own buffer covers
  // the WebAuthn tail a dummy signature never reaches.
  verificationGasLimit: 2_000_000n,
  preVerificationGas: 150_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n
});

/**
 * Build and passkey-sign the operation that brings the account into existence.
 * The configuration is rebuilt from the handle and rejected unless it re-derives
 * the account's own address, so this can never create a different account.
 */
export async function prepareActivation(input: {
  account: AccountHandle;
  deployment: WalletDeployment;
  balanceWei: bigint;
}): Promise<ActivationPreparation> {
  const { account, deployment } = input;
  if (account.kind !== "derived") throw new Error("A recovered account already exists on chain.");

  const config = resolveCreationConfig(account, deployment);
  if (!config) {
    throw new Error("This account's creation configuration could not be reproduced from the saved handle, so it cannot be created safely.");
  }

  const signer = createWebAuthnSigner({
    validator: deployment.validator,
    origin: account.origin,
    rpId: account.rpId,
    credentialId: account.credentialId,
    signChallenge: signWithBrowserPasskey
  });

  const client = createLoomClient({
    chainId: account.chainId,
    account: account.account,
    signer: {
      dummySignature: signer.dummySignature,
      verificationGasBuffer: signer.verificationGasBuffer,
      async signUserOperation() { throw new Error("the creation hash is signed directly"); }
    }
  });

  const prepared = client.prepareUserOperation(client.prepareCalls({ calls: [] }), {
    // A counterfactual account has never acted, so its EntryPoint nonce is zero.
    nonce: 0n,
    factory: deployment.factory,
    factoryData: encodeCreateAccountCall(account.salt, config),
    ...CREATION_GAS
  });

  const operation = (prepared as { userOperation?: unknown }).userOperation ?? prepared;
  const fields = operation as unknown as Record<string, unknown>;
  const unsigned = packUserOperation({ ...fields, signature: "0x" } as never);
  const userOpHash = getUserOpHash(unsigned, deployment.entryPoint, BigInt(account.chainId));
  const signature = await signer.sign(userOpHash);
  const packed = packUserOperation({ ...fields, signature } as never);

  const maxCost = (CREATION_GAS.preVerificationGas + CREATION_GAS.verificationGasLimit + CREATION_GAS.callGasLimit)
    * CREATION_GAS.maxFeePerGas;

  return Object.freeze({
    userOpHash,
    packed: serialize(packed as unknown as Record<string, unknown>),
    selfFunded: input.balanceWei >= maxCost
  });
}

/**
 * Hand the signed operation to a submitter. The relay publishes it and, when the
 * account cannot cover its own creation, funds the attempt; either way it cannot
 * alter the operation it carries.
 */
export async function submitActivation(input: {
  config: NetworkConfig;
  preparation: ActivationPreparation;
}): Promise<ActivationResult> {
  const relay = input.config.relayUrl.trim();
  if (!relay) {
    throw new Error("No submitter is configured. Add a sponsor relay in Developer settings, or publish the signed operation from any funded wallet.");
  }
  const url = `${relay.replace(/\/$/, "")}/deploy${input.preparation.selfFunded ? "?mode=self-funded" : ""}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.preparation.packed)
    });
  } catch (cause) {
    throw new Error(`The submitter at ${relay} could not be reached.`, { cause });
  }

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (body as { error?: unknown }).error;
    throw new Error(typeof detail === "string" ? detail : `The submitter refused the operation (${response.status}).`);
  }

  const record = body as { account?: unknown; opTx?: unknown; alreadyDeployed?: unknown };
  return Object.freeze({
    account: String(record.account ?? "") as Address,
    ...(typeof record.opTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.opTx) ? { transactionHash: record.opTx as Hex } : {}),
    alreadyDeployed: record.alreadyDeployed === true
  });
}

/** JSON carries no bigints; the submitter parses these back. */
function serialize(operation: Record<string, unknown>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(operation)) {
    output[key] = typeof value === "bigint" ? value.toString() : String(value);
  }
  return Object.freeze(output);
}
