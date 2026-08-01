import type { Address, Hex } from "@loom/core";
import {
  createBundlerTransport,
  createLoomClient,
  createPasskeySigner,
  createRpcStateTransport,
  readAccountSafetyState,
  type AccountSafetyState,
  type LoomTransportAdapter
} from "@loom/sdk";
import { AppError, normalizeAppError } from "../../domain/errors/appError";
import {
  reduceOperationState,
  type OperationEvent,
  type OperationState
} from "../../domain/operations/operationState";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";
import { signWithBrowserPasskey } from "./webauthn";
import { confirmUserOperationReceipt } from "../../services/loom/operationReceipt";
import type { PendingOperationStore } from "../../storage/pendingOperations";
import type { RuntimeVerifier } from "../../services/runtime/runtimeVerifier";
import type { PublicClientRegistry } from "../../services/rpc/publicClients";
import { acquireAccountOperation } from "../../services/loom/operationGuard";

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

export type AccountOperationObserver = (state: OperationState) => void;

// Submit account calls through a public ERC-4337 bundler. The passkey signs the
// canonical operation hash; the bundler carries it and cannot alter a single
// field, so the account is bound to no particular submitter. Used for ETH,
// ERC-20, and NFT transfers alike — only the encoded call differs.
export async function submitAccountCalls(input: {
  config: NetworkConfig;
  account: AccountHandle;
  deployment: WalletDeployment;
  calls: readonly AccountCall[];
  onState?: AccountOperationObserver;
  pendingOperations: PendingOperationStore;
  runtime: RuntimeVerifier;
  publicClients: PublicClientRegistry;
}): Promise<SendResult> {
  const { config, account, deployment, calls, onState, pendingOperations, runtime, publicClients } = input;
  let state: OperationState = { status: "idle" };
  let submittedHash: Hex | undefined;
  const emit = (event: OperationEvent) => {
    state = reduceOperationState(state, event);
    onState?.(state);
  };
  emit({ type: "VALIDATE" });
  if (calls.length === 0) {
    const error = new AppError({
      code: "INVALID_INPUT",
      userMessage: "There is nothing to submit.",
      retryable: false,
      stage: "validation"
    });
    emit({ type: "FAIL", error });
    throw error;
  }
  let release: (() => void) | undefined;
  const validator = account.kind === "recovered" ? account.validator : deployment.validator;
  try {
    release = await acquireAccountOperation(account.id, pendingOperations);
    await runtime.verify(config, deployment);
    emit({ type: "PREPARE" });
    const signer = createPasskeySigner({
      credentialId: account.credentialId,
      rpId: account.rpId,
      origin: account.origin,
      validator,
      entryPoint: deployment.entryPoint,
      signChallenge: async challenge => {
        emit({ type: "REQUEST_PASSKEY" });
        const signature = await signWithBrowserPasskey(challenge);
        emit({ type: "SIGN" });
        return signature;
      }
    });

    const baseTransport = createBundlerTransport({ endpoint: config.bundlerUrl, entryPoint: deployment.entryPoint });
    const transport: LoomTransportAdapter = {
      ...baseTransport,
      async getUserOperationGasPrice(tier) {
        emit({ type: "PREPARE" });
        if (!baseTransport.getUserOperationGasPrice) throw new Error("Bundler gas pricing is unavailable");
        return baseTransport.getUserOperationGasPrice(tier);
      },
      async estimateUserOperationGas(envelope) {
        emit({ type: "ESTIMATE" });
        if (!baseTransport.estimateUserOperationGas) throw new Error("Bundler gas estimation is unavailable");
        return baseTransport.estimateUserOperationGas(envelope);
      },
      async sendUserOperation(envelope) {
        emit({ type: "SUBMIT" });
        const sent = await baseTransport.sendUserOperation(envelope);
        submittedHash = sent.userOpHash;
        await pendingOperations.save({ accountId: account.id, userOperationHash: sent.userOpHash, submittedAt: Date.now() });
        emit({ type: "CONFIRM", userOperationHash: sent.userOpHash });
        return sent;
      }
    };

    const client = createLoomClient({
      chainId: account.chainId,
      account: account.account,
      transport,
      stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
      signer
    });

    const result = await client.sendTransaction(
      { calls: calls.map(call => ({ target: call.target, value: call.value, data: call.data })) }
    );
    const transactionHash = await confirmUserOperationReceipt({
      receipt: result.receipt,
      expectedUserOperationHash: result.userOpHash,
      expectedSender: account.account,
      entryPoint: deployment.entryPoint,
      publicClient: publicClients.forEndpoint(config.rpcUrl),
      verificationPublicClient: publicClients.forEndpoint(config.verificationRpcUrl)
    });
    await pendingOperations.complete(account.id, result.userOpHash);
    emit({ type: "SUCCEED", userOperationHash: result.userOpHash, transactionHash });
    return { userOpHash: result.userOpHash, transactionHash };
  } catch (issue) {
    const error = normalizeAppError(issue, submittedHash ? "confirmation" : "submission");
    emit({ type: "FAIL", error, ...(submittedHash ? { userOperationHash: submittedHash } : {}) });
    throw error;
  } finally {
    release?.();
  }
}
