import type { Address, Hex } from "@loom/core";
import type { UserOperationReceipt } from "@loom/sdk";
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

function receiptError(code: "USER_OPERATION_REJECTED" | "TRANSACTION_REVERTED", userMessage: string, diagnostic: string): AppError {
  return new AppError({ code, userMessage, diagnostic, retryable: code !== "TRANSACTION_REVERTED", stage: "confirmation" });
}
