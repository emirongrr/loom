import type { Hex } from "@loom/core";
import type { UserOperationReceipt } from "@loom/sdk";
import type { NetworkConfig } from "../../config/network";
import type { AccountHandle } from "../../types";
import type { PendingOperation, PendingOperationStore } from "../../storage/pendingOperations";
import { normalizeAppError, type AppError } from "../../domain/errors/appError.ts";
import { confirmUserOperationReceipt } from "./operationReceipt.ts";
import type { Address } from "@loom/core";
import type { PublicClient } from "viem";

export type PendingConfirmationResult =
  | { readonly status: "pending"; readonly userOperationHash: Hex }
  | { readonly status: "success"; readonly userOperationHash: Hex; readonly transactionHash: Hex }
  | { readonly status: "failed"; readonly userOperationHash: Hex; readonly error: AppError };

export async function resumePendingConfirmation(input: {
  config: NetworkConfig;
  account: AccountHandle;
  operation: PendingOperation;
  store: PendingOperationStore;
  entryPoint: Address;
  publicClient: PublicClient;
  verificationPublicClient: PublicClient;
  request?: typeof fetch;
}): Promise<PendingConfirmationResult> {
  const response = await (input.request ?? fetch)(input.config.bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [input.operation.userOperationHash] })
  });
  if (!response.ok) return { status: "pending", userOperationHash: input.operation.userOperationHash };
  const body = await response.json() as { result?: UserOperationReceipt | null };
  if (!body.result) return { status: "pending", userOperationHash: input.operation.userOperationHash };
  try {
    const transactionHash = await confirmUserOperationReceipt({
      receipt: body.result,
      expectedUserOperationHash: input.operation.userOperationHash,
      expectedSender: input.account.account,
      entryPoint: input.entryPoint,
      publicClient: input.publicClient,
      verificationPublicClient: input.verificationPublicClient
    });
    await input.store.complete(input.account.id, input.operation.userOperationHash);
    return { status: "success", userOperationHash: input.operation.userOperationHash, transactionHash };
  } catch (issue) {
    return { status: "failed", userOperationHash: input.operation.userOperationHash, error: normalizeAppError(issue, "confirmation") };
  }
}
