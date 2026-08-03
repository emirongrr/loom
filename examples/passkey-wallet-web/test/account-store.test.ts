import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserAccountStore } from "../src/storage/accountStore.ts";
import { migrateLegacyAccountHandle, migrateLegacyAccountHandles } from "../src/features/onboarding/accountLifecycle.ts";
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
    version: 1,
    kind: "derived",
    id: `wallet-${index}`,
    label: `Wallet ${index}`,
    account: `0x${byte.repeat(20)}`,
    chainId: 11155111,
    credentialId: `0x${byte}`,
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5173",
    salt: `0x${"33".repeat(32)}`,
    creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0 }
  };
}

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
  storage.setItem("loom.wallet.accounts.removed.v1", "not-json");

  assert.deepEqual((await store.list()).map(item => item.id), ["wallet-1"]);
  assert.equal(await store.isRemoved("wallet-1"), false);
});

test("successful recovery links the new passkey to the existing saved wallet identity", async () => {
  const store = createBrowserAccountStore(memoryStorage());
  const existing = { ...handle(1), id: "legacy-wallet-record", label: "My daily wallet" };
  const untouched = handle(2);
  await store.save(existing);
  await store.save(untouched);

  const recovered = await store.linkRecovered({
    version: 1,
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

  assert.equal(recovered.id, "legacy-wallet-record");
  assert.equal(recovered.label, "My daily wallet");
  assert.equal(recovered.kind, "recovered");
  assert.equal(recovered.credentialId, "0xcafe");
  assert.deepEqual((await store.list()).map(item => [item.id, item.label]), [
    ["legacy-wallet-record", "My daily wallet"],
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
    version: 1,
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

test("legacy single-wallet storage is copied into a list handle without deleting its source", async () => {
  const storage = memoryStorage();
  const legacyWallet = JSON.stringify({
    credentialId: "0xcafe",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` }
  });
  const legacyDeployment = JSON.stringify({
    chainId: 11155111,
    entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
    factory: "0x2d8610879998c90c0539d4668e5d3a5297a68d6e",
    implementation: "0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24",
    validator: "0xd86b5531361f6382342f59700ff1b309919eaf0a",
    policyHook: "0xceda8174e7943765993bd09c6d714a0a3d1dd82a",
    proxyCreationCode: "0x6000"
  });
  storage.setItem("loom.passkey-wallet.handle", legacyWallet);
  storage.setItem("loom.passkey-wallet.deployment", legacyDeployment);

  const migrated = await migrateLegacyAccountHandle(storage, { rpId: "localhost", origin: "http://localhost:5174" });

  assert.equal(migrated?.label, "Previous wallet");
  assert.equal(migrated?.kind, "derived");
  assert.equal(migrated?.kind === "derived" ? migrated.creation.guardianThreshold : 0, 1);
  assert.equal(storage.getItem("loom.passkey-wallet.handle"), legacyWallet);
  assert.equal(storage.getItem("loom.passkey-wallet.deployment"), legacyDeployment);
});

test("legacy wallet uses the bundled deployment when its old deployment record is missing", async () => {
  const storage = memoryStorage();
  const legacyWallet = JSON.stringify({
    credentialId: "0xcafe",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` }
  });
  storage.setItem("loom.passkey-wallet.handle", legacyWallet);
  const bundledDeployment = {
    chainId: 11155111,
    entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
    factory: "0x2d8610879998c90c0539d4668e5d3a5297a68d6e",
    implementation: "0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24",
    validator: "0xd86b5531361f6382342f59700ff1b309919eaf0a",
    policyHook: "0xceda8174e7943765993bd09c6d714a0a3d1dd82a",
    proxyCreationCode: "0x6000"
  } as const;

  const migrated = await migrateLegacyAccountHandle(
    storage,
    { rpId: "localhost", origin: "http://localhost:5174" },
    async () => bundledDeployment
  );

  assert.equal(migrated?.label, "Previous wallet");
  assert.equal(storage.getItem("loom.passkey-wallet.handle"), legacyWallet);
  assert.equal(storage.getItem("loom.passkey-wallet.deployment"), null);
});

test("every healthy wallet in the previous multi-account registry is copied without changing its source", async () => {
  const storage = memoryStorage();
  const legacyAccounts = JSON.stringify([
    {
      credentialId: "0x01",
      publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"21".repeat(32)}` },
      guardianRoot: `0x${"31".repeat(32)}`,
      guardianThreshold: 2,
      label: "First wallet"
    },
    {
      credentialId: "0x02",
      publicKey: { x: `0x${"12".repeat(32)}`, y: `0x${"22".repeat(32)}` },
      guardianRoot: `0x${"32".repeat(32)}`,
      guardianThreshold: 1,
      label: "Second wallet"
    },
    {
      credentialId: "0x03",
      publicKey: { x: `0x${"13".repeat(32)}`, y: `0x${"23".repeat(32)}` },
      guardianRoot: `0x${"33".repeat(32)}`,
      guardianThreshold: 0,
      label: "Third wallet"
    }
  ]);
  storage.setItem("loom.passkey-wallet.accounts", legacyAccounts);

  const migrated = await migrateLegacyAccountHandles(
    storage,
    { rpId: "localhost", origin: "http://localhost:5174" },
    async () => bundledDeployment()
  );

  assert.deepEqual(migrated.map(wallet => wallet.label), ["First wallet", "Second wallet", "Third wallet"]);
  assert.equal(new Set(migrated.map(wallet => wallet.id)).size, 3);
  assert.equal(storage.getItem("loom.passkey-wallet.accounts"), legacyAccounts);
});

test("a corrupt previous-list entry cannot hide healthy wallets", async () => {
  const storage = memoryStorage();
  const legacyAccounts = JSON.stringify([
    {
      credentialId: "not-hex",
      publicKey: { x: "bad", y: "bad" },
      label: "Corrupt wallet"
    },
    {
      credentialId: "0x04",
      publicKey: { x: `0x${"14".repeat(32)}`, y: `0x${"24".repeat(32)}` },
      guardianRoot: `0x${"34".repeat(32)}`,
      guardianThreshold: 1,
      label: "Healthy wallet"
    }
  ]);
  storage.setItem("loom.passkey-wallet.accounts", legacyAccounts);

  const migrated = await migrateLegacyAccountHandles(
    storage,
    { rpId: "localhost", origin: "http://localhost:5174" },
    async () => bundledDeployment()
  );

  assert.deepEqual(migrated.map(wallet => wallet.label), ["Healthy wallet"]);
  assert.equal(storage.getItem("loom.passkey-wallet.accounts"), legacyAccounts);
});

function bundledDeployment() {
  return {
    chainId: 11155111,
    entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
    factory: "0x2d8610879998c90c0539d4668e5d3a5297a68d6e",
    implementation: "0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24",
    validator: "0xd86b5531361f6382342f59700ff1b309919eaf0a",
    policyHook: "0xceda8174e7943765993bd09c6d714a0a3d1dd82a",
    proxyCreationCode: "0x6000"
  } as const;
}
