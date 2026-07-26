import type { Address, Hex } from "@loom/core";
import {
  createBundlerTransport,
  createLoomClient,
  createPasskeySigner,
  createRpcStateTransport,
  readAccountSafetyState,
  type AccountSafetyState
} from "@loom/sdk";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";
import { signWithBrowserPasskey } from "./webauthn";

export async function readAccountSafety(
  config: NetworkConfig,
  account: AccountHandle
): Promise<AccountSafetyState> {
  return readAccountSafetyState({
    chainId: account.chainId,
    account: account.account,
    stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
    ...(account.kind === "derived" && account.creation.recoveryModule
      ? { recoveryModule: account.creation.recoveryModule }
      : {})
  });
}

export interface SendResult {
  readonly userOpHash: Hex;
  readonly transactionHash?: Hex;
}

export interface AccountCall {
  readonly target: Address;
  readonly value: bigint;
  readonly data: Hex;
}

// Submit account calls through a public ERC-4337 bundler. The passkey signs the
// canonical operation hash; the bundler carries it and cannot alter a single
// field, so the account is bound to no particular submitter. Used for ETH,
// ERC-20, and NFT transfers alike — only the encoded call differs.
export async function submitAccountCalls(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
  calls: readonly AccountCall[];
}): Promise<SendResult> {
  const { config, account, deployment, calls } = input;
  if (calls.length === 0) throw new Error("There is nothing to submit.");
  const validator = account.kind === "recovered" ? account.validator : deployment.validator;

  // The SDK passkey signer computes the canonical operation hash, carries it to
  // the authenticator as the WebAuthn challenge, and encodes the account-ready
  // validator signature. The account is bound to no submitter: the same signed
  // operation is valid through any bundler.
  const signer = createPasskeySigner({
    credentialId: account.credentialId,
    rpId: account.rpId,
    origin: account.origin,
    validator,
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

  // Fees and gas are left to the bundler's own estimation; it is the only party
  // that knows the price it will accept, and overstating them overpays the relayer.
  const result = await client.sendTransaction({ calls: calls.map(call => ({ target: call.target, value: call.value, data: call.data })) });
  const transactionHash = receiptTransactionHash(result.receipt);
  return transactionHash ? { userOpHash: result.userOpHash, transactionHash } : { userOpHash: result.userOpHash };
}

function receiptTransactionHash(receipt: unknown): Hex | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  const value = (receipt as { receipt?: { transactionHash?: unknown }; transactionHash?: unknown });
  const hash = value.receipt?.transactionHash ?? value.transactionHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as Hex) : undefined;
}
