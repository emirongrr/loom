import type { Hex } from "@loom/core";

const STORAGE_KEY = "loom.wallet.pending-operations.v1";

export interface PendingOperation {
  readonly accountId: string;
  readonly userOperationHash: Hex;
  readonly submittedAt: number;
}

export interface PendingOperationStore {
  list(accountId: string): Promise<readonly PendingOperation[]>;
  save(operation: PendingOperation): Promise<void>;
  complete(accountId: string, userOperationHash: Hex): Promise<void>;
}

export function createBrowserPendingOperationStore(storage: Storage = window.localStorage): PendingOperationStore {
  const readAll = (): PendingOperation[] => {
    const text = storage.getItem(STORAGE_KEY);
    if (!text) return [];
    try {
      const values: unknown = JSON.parse(text);
      if (!Array.isArray(values)) return [];
      return values.flatMap(value => {
        if (!value || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        if (typeof record.accountId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(String(record.userOperationHash)) || !Number.isSafeInteger(record.submittedAt)) return [];
        return [{ accountId: record.accountId, userOperationHash: record.userOperationHash as Hex, submittedAt: Number(record.submittedAt) }];
      });
    } catch { return []; }
  };
  const writeAll = (values: readonly PendingOperation[]) => storage.setItem(STORAGE_KEY, JSON.stringify(values));
  return Object.freeze({
    async list(accountId: string) { return Object.freeze(readAll().filter(value => value.accountId === accountId)); },
    async save(operation: PendingOperation) {
      const values = readAll().filter(value => !(value.accountId === operation.accountId && value.userOperationHash.toLowerCase() === operation.userOperationHash.toLowerCase()));
      writeAll([...values, Object.freeze({ ...operation })]);
    },
    async complete(accountId: string, userOperationHash: Hex) {
      writeAll(readAll().filter(value => !(value.accountId === accountId && value.userOperationHash.toLowerCase() === userOperationHash.toLowerCase())));
    }
  });
}
