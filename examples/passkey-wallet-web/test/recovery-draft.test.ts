import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryDraft, createRecoveryDraftRepository } from "../src/features/recovery/recoveryDraft.ts";
import type { EncryptedStore } from "../src/storage/encryptedStore.ts";
import { keccak256 } from "viem";

const draft = createRecoveryDraft({
  chainId: 11155111, account: "0x1111111111111111111111111111111111111111", configVersion: "1", label: "Recovered wallet", createdAt: 100,
  preparation: {
    passkey: { credentialId: "0x1234", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` } },
    rpId: "localhost", origin: "http://localhost:5174", initData: "0xabcd", validator: "0x2222222222222222222222222222222222222222",
    initDataHash: keccak256("0xabcd"), alreadyDeployed: false,
    deploy: { to: "0x3333333333333333333333333333333333333333", data: "0x1234", value: 0n, permissionless: true }
  }
});

test("a prepared recovery passkey round-trips before guardian request creation", async () => {
  const values: { key: string; value: unknown; corrupt: boolean }[] = [];
  const store: EncryptedStore = { async entries() { return values; }, async put(key, value) { values.push({ key, value, corrupt: false }); }, async remove() {} };
  const repository = createRecoveryDraftRepository(store);
  await repository.write(draft);
  const restored = (await repository.inspect()).drafts[0]!;
  assert.equal(restored.preparation.passkey.credentialId, "0x1234");
  assert.equal(restored.preparation.validator, draft.preparation.validator);
});

test("corrupt or mismatched drafts cannot hide a healthy recovery passkey", async () => {
  const store: EncryptedStore = { async entries() { return [
    { key: "corrupt", value: undefined, corrupt: true },
    { key: draft.id, value: draft, corrupt: false },
    { key: "wrong", value: { ...draft, id: "wrong" }, corrupt: false }
  ]; }, async put() {}, async remove() {} };
  const snapshot = await createRecoveryDraftRepository(store).inspect();
  assert.deepEqual(snapshot.drafts.map(item => item.id), [draft.id]);
  assert.deepEqual(snapshot.issues, ["corrupt", "wrong"]);
});
