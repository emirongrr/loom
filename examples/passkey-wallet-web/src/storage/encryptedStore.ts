// A small authenticated-encryption store over IndexedDB. The key is generated
// non-extractable in the browser and never leaves it. This reduces casual
// storage disclosure; it is not hardware-backed isolation, and an XSS running on
// this origin can still use the key.

import { resolveDeviceKey } from "./deviceKey.ts";

export interface StoredEnvelope {
  readonly version: 1 | 2;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface EncryptedStore {
  entries(): Promise<readonly { key: string; value: unknown; corrupt: boolean }[]>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createEncryptedStore(dbName: string): EncryptedStore {
  return Object.freeze({
    async entries() {
      const db = await open(dbName);
      const store = db.transaction("records", "readonly").objectStore("records");
      const [keys, envelopes] = await Promise.all([
        promise<IDBValidKey[]>(store.getAllKeys()),
        promise<unknown[]>(store.getAll())
      ]);
      if (keys.length !== envelopes.length) throw new Error("encrypted store index is inconsistent");
      const key = await deviceKey(db);
      const results: { key: string; value: unknown; corrupt: boolean }[] = [];
      for (let index = 0; index < keys.length; index += 1) {
        const entryKey = String(keys[index]);
        try {
          const envelope = envelopes[index];
          const value = await decryptEnvelope(key, envelope, entryKey);
          // A version 1 envelope was written before the record key became
          // additional authenticated data, so it is not bound to the key it sits
          // under: anything able to write this database could move one ciphertext
          // to another record's key and have it decrypt cleanly there. Reading it
          // is the moment that can be repaired, and the alternative -- refusing
          // version 1 outright -- destroys records that are otherwise intact.
          //
          // Best effort on purpose. A failed rewrite leaves the record exactly as
          // it was and the value already decrypted is still returned, so a
          // read-only situation degrades to the old behaviour rather than to an
          // error.
          if (version(envelope) === 1) await upgrade(db, key, entryKey, envelope, value);
          results.push({ key: entryKey, value, corrupt: false });
        } catch {
          results.push({ key: entryKey, value: undefined, corrupt: true });
        }
      }
      return Object.freeze(results);
    },
    async put(key: string, value: unknown) {
      const db = await open(dbName);
      const envelope = await encryptEnvelope(await deviceKey(db), value, key);
      await done(db, "readwrite", store => store.put(envelope, key));
    },
    async remove(key: string) {
      const db = await open(dbName);
      await done(db, "readwrite", store => store.delete(key));
    }
  });
}

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records");
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("encrypted store could not open"));
  });
}

function deviceKey(db: IDBDatabase): Promise<CryptoKey> {
  return resolveDeviceKey({
    read: () => promise<CryptoKey | undefined>(db.transaction("keys", "readonly").objectStore("keys").get("device-key")),
    create: () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    add: key => done(db, "readwrite", store => store.add(key, "device-key"), "keys")
  });
}

/** Exported so the record-key binding can be tested without IndexedDB. */
export async function encryptEnvelope(key: CryptoKey, value: unknown, recordKey: string): Promise<StoredEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(recordKey) }, key, plaintext);
  return { version: 2, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

/** @see encryptEnvelope */
export async function decryptEnvelope(key: CryptoKey, value: unknown, recordKey: string): Promise<unknown> {
  if (!value || typeof value !== "object") throw new Error("envelope is invalid");
  const envelope = value as Partial<StoredEnvelope>;
  if ((envelope.version !== 1 && envelope.version !== 2) || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("unsupported envelope");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(unbase64(envelope.iv)), ...(envelope.version === 2 ? { additionalData: aad(recordKey) } : {}) },
    key,
    bytes(unbase64(envelope.ciphertext))
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function version(value: unknown): StoredEnvelope["version"] | undefined {
  return value && typeof value === "object" ? (value as Partial<StoredEnvelope>).version : undefined;
}

/**
 * Rewrite a decrypted record as a version 2 envelope, bound to its record key.
 *
 * Never rejects. The caller has already decrypted the value successfully, and a
 * record that cannot be rewritten is no worse off than before the attempt --
 * reporting it as unreadable would be a strictly worse outcome than the problem
 * being repaired.
 */
async function upgrade(db: IDBDatabase, key: CryptoKey, recordKey: string, readSnapshot: unknown, value: unknown): Promise<void> {
  try {
    const envelope = await encryptEnvelope(key, value, recordKey);
    await replaceLegacyEnvelope(db, recordKey, readSnapshot, envelope);
  } catch { /* Best effort; the record stays readable either way. */ }
}

/**
 * Return the replacement only while the legacy ciphertext read by the caller is
 * still current. A concurrent put or remove must win over this best-effort
 * migration; an upgrade triggered by a stale read must never restore old data.
 */
export function replacementIfCurrent(
  current: unknown,
  readSnapshot: unknown,
  replacement: StoredEnvelope
): StoredEnvelope | undefined {
  if (!current || typeof current !== "object" || !readSnapshot || typeof readSnapshot !== "object") return undefined;
  const actual = current as Partial<StoredEnvelope>;
  const expected = readSnapshot as Partial<StoredEnvelope>;
  if (actual.version !== 1 || expected.version !== 1 || replacement.version !== 2) return undefined;
  if (typeof actual.iv !== "string" || typeof actual.ciphertext !== "string") return undefined;
  if (typeof expected.iv !== "string" || typeof expected.ciphertext !== "string") return undefined;
  return actual.iv === expected.iv && actual.ciphertext === expected.ciphertext ? replacement : undefined;
}

function replaceLegacyEnvelope(
  db: IDBDatabase,
  recordKey: string,
  readSnapshot: unknown,
  replacement: StoredEnvelope
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    const reading = store.get(recordKey);
    reading.onsuccess = () => {
      const next = replacementIfCurrent(reading.result, readSnapshot, replacement);
      if (next) store.put(next, recordKey);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("encrypted store upgrade failed"));
    tx.onabort = () => reject(tx.error ?? new Error("encrypted store upgrade aborted"));
  });
}

function aad(recordKey: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`loom.encrypted-store.v2:${recordKey}`);
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unbase64(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function bytes(value: Uint8Array): ArrayBuffer { return value.slice().buffer as ArrayBuffer; }

function promise<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("encrypted store request failed"));
  });
}

function done(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  mutate: (store: IDBObjectStore) => IDBRequest,
  storeName = "records"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    mutate(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("encrypted store transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("encrypted store transaction aborted"));
  });
}
