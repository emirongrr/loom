import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserAccountStore } from "../src/storage/accountStore.ts";
import type { AccountHandle } from "../src/types.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); }
  } as Storage;
}

function handle(index: number): AccountHandle {
  const byte = index.toString(16).padStart(2, "0");
  return {
    version: 3,
    kind: "derived",
    id: `wallet-${index}`,
    label: `Wallet ${index}`,
    account: `0x${byte.repeat(20)}`,
    chainId: 11155111,
    credentialId: `0x${byte}`,
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5173",
    accountHandle: `0x${"33".repeat(32)}`,
    creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0, migrationModule: null }
  };
}

test("v3 storage never imports or rewrites an older saved-wallet namespace", async () => {
  const storage = memoryStorage();
  const previous = JSON.stringify([{ ...handle(1), version: 1, salt: `0x${"44".repeat(32)}`, accountHandle: undefined }]);
  storage.setItem("loom.wallet.accounts.v1", previous);
  const store = createBrowserAccountStore(storage);

  assert.deepEqual(await store.list(), []);
  await store.save(handle(2));

  assert.equal(storage.getItem("loom.wallet.accounts.v1"), previous);
  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-2"]);
});

test("derived records require an explicit migration-module binding", async () => {
  const withoutBinding = { ...handle(1), creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0 } };
  const store = createBrowserAccountStore(memoryStorage());

  await assert.rejects(store.save(withoutBinding as never), /migration module binding/);
});

test("account store never evicts an older wallet when another wallet is saved", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  for (let index = 1; index <= 33; index += 1) await store.save(handle(index));

  const saved = await store.list();
  assert.equal(saved.length, 33);
  assert.equal(saved.some(item => item.id === "wallet-1"), true);
  assert.equal(saved.some(item => item.id === "wallet-33"), true);
});

test("updating one saved wallet preserves every other wallet", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  await store.save(handle(1));
  await store.save(handle(2));
  await store.save({ ...handle(1), label: "Primary wallet" });

  assert.deepEqual((await store.list()).map(item => [item.id, item.label]), [
    ["wallet-1", "Primary wallet"],
    ["wallet-2", "Wallet 2"]
  ]);
});

test("removing one saved wallet preserves every other wallet and can be explicitly restored", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  await store.save(handle(1));
  await store.save(handle(2));

  assert.equal(await store.remove("wallet-1"), true);
  assert.equal(await store.isRemoved("wallet-1"), true);
  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-2"]);

  await store.save(handle(1));
  assert.equal(await store.isRemoved("wallet-1"), false);
  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-1", "wallet-2"]);
});

test("removing an unknown wallet does not create a hidden account binding", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  assert.equal(await store.remove("wallet-9"), false);
  assert.equal(await store.isRemoved("wallet-9"), false);
});

test("a corrupt removed-wallet record cannot hide healthy wallets", async () => {
  const storage = memoryStorage();
  const store = createBrowserAccountStore(storage);
  await store.save(handle(1));
  storage.setItem("loom.wallet.accounts.removed.v3", "not-json");

  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-1"]);
  assert.equal(await store.isRemoved("wallet-1"), false);
});

test("a corrupt saved-wallet record cannot hide healthy wallets", async () => {
  const storage = memoryStorage();
  const store = createBrowserAccountStore(storage);
  await store.save(handle(1));
  await store.save(handle(2));
  const stored = JSON.parse(storage.getItem("loom.wallet.accounts.v3") as string) as unknown[];
  storage.setItem("loom.wallet.accounts.v3", JSON.stringify([stored[0], { version: 3, kind: "derived", id: "damaged" }, stored[1]]));

  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-2", "wallet-1"]);
  const snapshot = await store.inspect();
  assert.equal(snapshot.issues.length, 1, "the unreadable record is reported, not hidden");
  assert.equal(snapshot.issues[0]?.index, 1);
});

test("an unreadable saved-wallet record survives later writes", async () => {
  // It may be a record written by a newer build of this wallet, which is
  // unreadable here and perfectly valid there. Dropping it on the next save
  // would turn a version skew into data loss.
  const storage = memoryStorage();
  const store = createBrowserAccountStore(storage);
  await store.save(handle(1));
  const future = { version: 4, kind: "derived", id: "written-by-a-newer-build" };
  const stored = JSON.parse(storage.getItem("loom.wallet.accounts.v3") as string) as unknown[];
  storage.setItem("loom.wallet.accounts.v3", JSON.stringify([...stored, future]));

  await store.save(handle(2));
  await store.remove("wallet-1");

  const remaining = JSON.parse(storage.getItem("loom.wallet.accounts.v3") as string) as unknown[];
  assert.deepEqual(remaining.filter(item => (item as { version?: number }).version === 4), [future]);
  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-2"]);
});

test("records beyond the saved-wallet limit survive an attempted update", async () => {
  const storage = memoryStorage();
  const store = createBrowserAccountStore(storage);
  const records = [handle(1), ...Array.from({ length: 256 }, (_, index) => ({
    version: 4,
    kind: "derived",
    id: `future-wallet-${index}`
  }))];
  const original = JSON.stringify(records);
  storage.setItem("loom.wallet.accounts.v3", original);
  storage.setItem("loom.wallet.accounts.removed.v3", JSON.stringify(["wallet-1"]));

  await assert.rejects(store.save({ ...handle(1), label: "Updated wallet" }), /saved account limit of 256 reached/);
  assert.equal(storage.getItem("loom.wallet.accounts.v3"), original);
  assert.equal(await store.isRemoved("wallet-1"), true, "a rejected update must not clear the removal marker");
});

test("an unreadable saved-wallet list reports itself instead of refusing to work", async () => {
  const storage = memoryStorage();
  const store = createBrowserAccountStore(storage);
  storage.setItem("loom.wallet.accounts.v3", "not-json");

  const snapshot = await store.inspect();
  assert.deepEqual(snapshot.accounts, []);
  assert.equal(snapshot.issues.length, 1);
  await store.save(handle(1));
  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-1"]);
});

test("successful recovery links the new passkey to the existing saved wallet identity", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  const existing = { ...handle(1), id: "saved-wallet-record", label: "My daily wallet" };
  const untouched = handle(2);
  await store.save(existing);
  await store.save(untouched);

  const recovered = await store.linkRecovered({
    version: 3,
    kind: "recovered",
    id: `${existing.chainId}:${existing.account.toLowerCase()}`,
    label: "Recovered wallet",
    account: existing.account.toUpperCase().replace("0X", "0x") as `0x${string}`,
    chainId: existing.chainId,
    credentialId: "0xcafe",
    publicKey: { x: `0x${"44".repeat(32)}`, y: `0x${"55".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5174",
    validator: `0x${"66".repeat(20)}`
  });

  assert.equal(recovered.id, "saved-wallet-record");
  assert.equal(recovered.label, "My daily wallet");
  assert.equal(recovered.kind, "recovered");
  assert.equal(recovered.credentialId, "0xcafe");
  assert.deepEqual((await store.list()).map(item => [item.id, item.label]), [
    ["saved-wallet-record", "My daily wallet"],
    [untouched.id, untouched.label]
  ]);
});

test("recovery linking is isolated by chain and leaves every other saved wallet unchanged", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  const target = handle(1);
  const sameAddressOnAnotherChain = { ...target, id: "other-chain", chainId: 1, label: "Ethereum wallet" };
  await store.save(target);
  await store.save(sameAddressOnAnotherChain);

  await store.linkRecovered({
    version: 3,
    kind: "recovered",
    id: "new-recovered-id",
    label: "Recovered wallet",
    account: target.account,
    chainId: target.chainId,
    credentialId: "0xcafe",
    publicKey: { x: `0x${"44".repeat(32)}`, y: `0x${"55".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5174",
    validator: `0x${"66".repeat(20)}`
  });

  const saved = await store.list();
  assert.equal(saved.length, 2);
  assert.equal(saved.find(item => item.chainId === 1)?.label, "Ethereum wallet");
  assert.equal(saved.find(item => item.chainId === target.chainId)?.credentialId, "0xcafe");
});
