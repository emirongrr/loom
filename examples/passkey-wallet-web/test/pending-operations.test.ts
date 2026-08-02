import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserPendingOperationStore } from "../src/storage/pendingOperations.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const A = "11155111:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "11155111:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const H1 = `0x${"11".repeat(32)}` as const;
const H2 = `0x${"22".repeat(32)}` as const;

test("pending confirmations are account-scoped and completion removes only the exact operation", async () => {
  const storage = new MemoryStorage();
  const store = createBrowserPendingOperationStore(storage);
  await store.save({ accountId: A, userOperationHash: H1, submittedAt: 1 });
  await store.save({ accountId: B, userOperationHash: H2, submittedAt: 2 });
  await store.complete(A, H1);
  assert.deepEqual(await store.list(A), []);
  assert.equal((await store.list(B))[0]?.userOperationHash, H2);
});

test("a corrupt pending record cannot hide healthy confirmations", async () => {
  const storage = new MemoryStorage();
  storage.setItem("loom.wallet.pending-operations.v1", JSON.stringify([
    { accountId: A, userOperationHash: "broken", submittedAt: 1 },
    { accountId: B, userOperationHash: H2, submittedAt: 2 }
  ]));
  const records = await createBrowserPendingOperationStore(storage).list(B);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.userOperationHash, H2);
});
