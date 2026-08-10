import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeviceKey, type DeviceKeySlot } from "../src/storage/deviceKey.ts";

/** An `add` that refuses to overwrite, which is what IndexedDB's `add` does. */
function slot(options: { onCreate?: () => void } = {}) {
  let stored: CryptoKey | undefined;
  let created = 0;
  const api: DeviceKeySlot & { readonly createdCount: () => number; readonly stored: () => CryptoKey | undefined } = {
    async read() { return stored; },
    async create() {
      created += 1;
      options.onCreate?.();
      return { id: `key-${created}` } as unknown as CryptoKey;
    },
    async add(key: CryptoKey) {
      if (stored) throw new Error("ConstraintError: key already exists");
      stored = key;
    },
    createdCount: () => created,
    stored: () => stored
  };
  return api;
}

test("an existing device key is adopted without generating another", async () => {
  const store = slot();
  const first = await resolveDeviceKey(store);
  const second = await resolveDeviceKey(store);

  assert.equal(first, second);
  assert.equal(store.createdCount(), 1);
});

test("a caller that loses the creation race adopts the stored key", async () => {
  // Both callers observe an empty slot before either writes -- two writes in
  // flight on first use, or two tabs on the same origin. Only one `add` can
  // win, and the loser must return the winner's key: records are encrypted
  // under whatever is stored, so returning its own would write records nothing
  // can read back.
  const store = slot();
  const [left, right] = await Promise.all([resolveDeviceKey(store), resolveDeviceKey(store)]);

  assert.equal(store.createdCount(), 2, "the race is the case under test");
  assert.equal(left, right, "both callers must end up on one key");
  assert.equal(left, store.stored(), "and it must be the key that was actually stored");
});

test("a write that fails for any other reason still surfaces", async () => {
  const broken: DeviceKeySlot = {
    async read() { return undefined; },
    async create() { return {} as CryptoKey; },
    async add() { throw new Error("quota exceeded"); }
  };

  await assert.rejects(resolveDeviceKey(broken), /device key could not be stored/u);
});
