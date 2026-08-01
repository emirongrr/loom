import { AppError } from "../../domain/errors/appError.ts";
import type { PendingOperationStore } from "../../storage/pendingOperations.ts";

const activeAccounts = new Set<string>();

export async function acquireAccountOperation(
  accountId: string,
  pendingOperations: PendingOperationStore
): Promise<() => void> {
  if (activeAccounts.has(accountId) || (await pendingOperations.list(accountId)).length > 0) {
    throw new AppError({
      code: "OPERATION_IN_PROGRESS",
      userMessage: "This wallet already has an operation awaiting confirmation. Resume it before submitting another operation.",
      diagnostic: "account has an active or persisted pending operation",
      retryable: true,
      stage: "validation"
    });
  }
  activeAccounts.add(accountId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAccounts.delete(accountId);
  };
}
