import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptEnvelope,
  encryptEnvelope,
  replacementIfCurrent,
  type StoredEnvelope
} from "../src/storage/encryptedStore.ts";

const deviceKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** A record written before the record key became additional authenticated data. */
async function legacyEnvelope(key: CryptoKey, value: unknown): Promise<StoredEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

test("a version 2 envelope only decrypts under the record key it was written for", async () => {
  const key = await deviceKey();
  const envelope = await encryptEnvelope(key, { draft: "recovery" }, "record-a");

  assert.deepEqual(await decryptEnvelope(key, envelope, "record-a"), { draft: "recovery" });
  await assert.rejects(decryptEnvelope(key, envelope, "record-b"));
});

test("a version 1 envelope is not bound to its record key, which is why it is upgraded", async () => {
  // This is the exposure the upgrade-on-read exists to remove: anything able to
  // write this database could move a version 1 ciphertext onto another record's
  // key and have it decrypt cleanly there.
  const key = await deviceKey();
  const legacy = await legacyEnvelope(key, { draft: "recovery" });

  assert.deepEqual(await decryptEnvelope(key, legacy, "record-a"), { draft: "recovery" });
  assert.deepEqual(
    await decryptEnvelope(key, legacy, "record-b"),
    { draft: "recovery" },
    "a version 1 ciphertext decrypts under any key, which is the defect"
  );

  // Rewriting it as version 2 under its own key -- what `entries` now does on
  // read -- closes it, and the value survives.
  const upgraded = await encryptEnvelope(key, await decryptEnvelope(key, legacy, "record-a"), "record-a");
  assert.equal(upgraded.version, 2);
  assert.deepEqual(await decryptEnvelope(key, upgraded, "record-a"), { draft: "recovery" });
  await assert.rejects(decryptEnvelope(key, upgraded, "record-b"));
});

test("a malformed envelope is refused rather than guessed at", async () => {
  const key = await deviceKey();
  await assert.rejects(decryptEnvelope(key, null, "record-a"), /envelope is invalid/u);
  await assert.rejects(decryptEnvelope(key, { version: 3, iv: "", ciphertext: "" }, "record-a"), /unsupported envelope/u);
  await assert.rejects(decryptEnvelope(key, { version: 2, iv: "" }, "record-a"), /unsupported envelope/u);
});

test("a legacy upgrade never overwrites a record changed after the read", async () => {
  const key = await deviceKey();
  const readSnapshot = await legacyEnvelope(key, { draft: "old" });
  const upgradedSnapshot = await encryptEnvelope(key, { draft: "old" }, "record-a");
  const concurrentWrite = await encryptEnvelope(key, { draft: "new" }, "record-a");

  assert.equal(replacementIfCurrent(readSnapshot, readSnapshot, upgradedSnapshot), upgradedSnapshot);
  assert.equal(replacementIfCurrent(concurrentWrite, readSnapshot, upgradedSnapshot), undefined);
  assert.equal(replacementIfCurrent(undefined, readSnapshot, upgradedSnapshot), undefined);
});
