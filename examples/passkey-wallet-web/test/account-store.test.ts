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
