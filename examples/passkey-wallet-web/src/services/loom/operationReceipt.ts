import type { Address, Hex } from "@loom/core";
import { EntryPointAbi } from "@loom/core/abi";
import type { UserOperationReceipt } from "@loom/sdk";
import { decodeEventLog, type PublicClient } from "viem";
import { AppError } from "../../domain/errors/appError.ts";

export function validateUserOperationReceipt(
  receipt: UserOperationReceipt | undefined,
  expectedUserOperationHash: Hex,
  expectedSender: Address
): Hex {
  if (!receipt || receipt.userOpHash.toLowerCase() !== expectedUserOperationHash.toLowerCase()) {
    throw receiptError("USER_OPERATION_REJECTED", "The bundler returned an invalid operation receipt.", "receipt hash mismatch");
  }
  if (receipt.sender && receipt.sender.toLowerCase() !== expectedSender.toLowerCase()) {
    throw receiptError("USER_OPERATION_REJECTED", "The bundler returned an invalid operation receipt.", "receipt sender mismatch");
  }
  if (!receipt.success) {
    throw receiptError("TRANSACTION_REVERTED", "The wallet operation reverted on-chain.", receipt.reason ?? "receipt reported failure");
  }
  const value = receipt.receipt as { transactionHash?: unknown } | undefined;
  const hash = value?.transactionHash;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw receiptError("USER_OPERATION_REJECTED", "The confirmed operation has no verifiable transaction hash.", "transaction hash missing");
  }
  return hash as Hex;
}

export async function confirmUserOperationReceipt(input: {
  receipt: UserOperationReceipt | undefined;
  expectedUserOperationHash: Hex;
  expectedSender: Address;
  entryPoint: Address;
  publicClient: PublicClient;
  verificationPublicClient: PublicClient;
}): Promise<Hex> {
  const transactionHash = validateUserOperationReceipt(
    input.receipt,
    input.expectedUserOperationHash,
    input.expectedSender
  );
  const chainReceipts = await Promise.all([
    input.publicClient.getTransactionReceipt({ hash: transactionHash }),
    input.verificationPublicClient.getTransactionReceipt({ hash: transactionHash })
  ]);
  for (const chainReceipt of chainReceipts) verifyChainReceipt(chainReceipt, transactionHash, input);
  return transactionHash;
}

function verifyChainReceipt(
  chainReceipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>,
  transactionHash: Hex,
  input: { expectedUserOperationHash: Hex; expectedSender: Address; entryPoint: Address }
): void {
  if (chainReceipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw receiptError("USER_OPERATION_REJECTED", "The transaction receipt could not be independently verified.", "RPC transaction hash mismatch");
  }
  if (chainReceipt.status !== "success") {
    throw receiptError("TRANSACTION_REVERTED", "The wallet operation reverted on-chain.", "chain transaction reverted");
  }
  const matched = chainReceipt.logs.some(log => {
    if (log.address.toLowerCase() !== input.entryPoint.toLowerCase()) return false;
    try {
      const decoded = decodeEventLog({ abi: EntryPointAbi, eventName: "UserOperationEvent", data: log.data, topics: log.topics });
      return decoded.args.userOpHash.toLowerCase() === input.expectedUserOperationHash.toLowerCase()
        && decoded.args.sender.toLowerCase() === input.expectedSender.toLowerCase()
        && decoded.args.success === true;
    } catch {
      return false;
    }
  });
  if (!matched) {
    throw receiptError("USER_OPERATION_REJECTED", "The transaction does not prove this wallet operation succeeded.", "matching EntryPoint UserOperationEvent missing");
  }
}

function receiptError(code: "USER_OPERATION_REJECTED" | "TRANSACTION_REVERTED", userMessage: string, diagnostic: string): AppError {
  return new AppError({ code, userMessage, diagnostic, retryable: code !== "TRANSACTION_REVERTED", stage: "confirmation" });
}
