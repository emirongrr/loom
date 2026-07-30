import { validateGuardianInvite, validatePersistedGuardianInvite, type GuardianInviteV1 } from "@loom/sdk/recovery";

export interface GuardianVaultRecord {
  readonly capability: GuardianInviteV1;
  readonly acceptedAt: number;
  readonly lastVerifiedAt?: number;
  readonly status: "unverified" | "active" | "stale" | "removed";
}

export interface GuardianVault {
  list(): Promise<readonly GuardianVaultRecord[]>;
  inspect(): Promise<GuardianVaultSnapshot>;
  put(record: GuardianVaultRecord): Promise<void>;
  remove(key: IDBValidKey): Promise<void>;
}

export interface GuardianVaultIssue {
  readonly key: IDBValidKey;
  readonly reason: "corrupt";
  readonly message: string;
}

export interface GuardianVaultSnapshot {
  readonly records: readonly GuardianVaultRecord[];
  readonly issues: readonly GuardianVaultIssue[];
}

interface StoredEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
}

export function createBrowserGuardianVault(options: { dbName?: string } = {}): GuardianVault {
  const dbName = options.dbName ?? "loom-guardian-vault-v1";
  const inspect = async () => {
    const db = await openVault(dbName);
    const transaction = db.transaction("records", "readonly");
    const store = transaction.objectStore("records");
    const [keys, envelopes] = await Promise.all([
      request<IDBValidKey[]>(store.getAllKeys()),
      request<StoredEnvelope[]>(store.getAll())
    ]);
    if (keys.length !== envelopes.length) throw new Error("guardian vault index is inconsistent");
    const key = await vaultKey(db);
    return decodeGuardianVaultEntries(keys.map((entryKey, index) => ({ key: entryKey, envelope: envelopes[index] })), key);
  };
  return Object.freeze({
    async list() {
      return (await inspect()).records;
    },
    inspect,
    async put(record: GuardianVaultRecord) {
      const db = await openVault(dbName);
      const key = await vaultKey(db);
      const capability = validateGuardianInvite(record.capability);
      const accepted = validateGuardianVaultRecord({ ...record, capability });
      const envelope = await encryptRecord(key, accepted);
      await transactionDone(db, "records", "readwrite", store => store.put(envelope, accepted.capability.capabilityId));
    },
    async remove(key: IDBValidKey) {
      const db = await openVault(dbName);
      await transactionDone(db, "records", "readwrite", store => store.delete(key));
    }
  });
}

export async function decodeGuardianVaultEntries(
  entries: readonly { readonly key: IDBValidKey; readonly envelope: unknown }[],
  key: CryptoKey,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<GuardianVaultSnapshot> {
  const records: GuardianVaultRecord[] = [];
  const issues: GuardianVaultIssue[] = [];
  for (const entry of entries) {
    try {
      const record = await decryptRecord(key, entry.envelope, nowSeconds);
      if (entry.key !== record.capability.capabilityId) throw new Error("guardian vault record key is invalid");
      records.push(record);
    } catch {
      issues.push(Object.freeze({ key: entry.key, reason: "corrupt", message: "Encrypted guardian record could not be verified." }));
    }
  }
  return Object.freeze({ records: Object.freeze(records), issues: Object.freeze(issues) });
}

async function openVault(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records");
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("guardian vault could not open"));
  });
}

async function vaultKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await request<CryptoKey | undefined>(db.transaction("keys", "readonly").objectStore("keys").get("device-key"));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await transactionDone(db, "keys", "readwrite", store => store.add(key, "device-key"));
  return key;
}

async function encryptRecord(key: CryptoKey, record: GuardianVaultRecord): Promise<StoredEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

async function decryptRecord(key: CryptoKey, value: unknown, nowSeconds: number): Promise<GuardianVaultRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guardian vault envelope is invalid");
  const envelope = value as Partial<StoredEnvelope>;
  if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") throw new Error("unsupported guardian vault envelope");
  const iv = unbase64(envelope.iv);
  const ciphertext = unbase64(envelope.ciphertext);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(iv) }, key, buffer(ciphertext));
    return validateGuardianVaultRecord(JSON.parse(new TextDecoder().decode(plaintext)), nowSeconds);
  } catch (cause) {
    throw new Error("guardian vault decryption failed", { cause });
  }
}

export function validateGuardianVaultRecord(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): GuardianVaultRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guardian vault record is invalid");
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (!(["unverified", "active", "stale", "removed"] as const).includes(status as never)) throw new Error("guardian vault status is invalid");
  if (typeof record.acceptedAt !== "number" || !Number.isFinite(record.acceptedAt) || record.acceptedAt <= 0) throw new Error("guardian vault acceptance time is invalid");
  if (record.lastVerifiedAt !== undefined && (typeof record.lastVerifiedAt !== "number" || !Number.isFinite(record.lastVerifiedAt) || record.lastVerifiedAt <= 0)) throw new Error("guardian vault verification time is invalid");
  const capability = validatePersistedGuardianInvite(record.capability);
  return Object.freeze({
    capability,
    acceptedAt: Number(record.acceptedAt),
    ...(record.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: Number(record.lastVerifiedAt) }),
    status: capability.expiresAt <= nowSeconds && status !== "removed" ? "stale" : status as GuardianVaultRecord["status"]
  });
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

function buffer(value: Uint8Array): ArrayBuffer { return value.slice().buffer as ArrayBuffer; }

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("guardian vault request failed"));
  });
}

function transactionDone(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, mutate: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    mutate(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("guardian vault transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("guardian vault transaction aborted"));
  });
}
