import type { AccountHandle } from "../types";

export interface AccountStore {
  list(): Promise<readonly AccountHandle[]>;
  save(handle: AccountHandle): Promise<void>;
  remove(accountId: string): Promise<boolean>;
  isRemoved(accountId: string): Promise<boolean>;
}

const KEY = "loom.wallet.accounts.v1";
const REMOVED_KEY = "loom.wallet.accounts.removed.v1";
const MAX_ACCOUNTS = 256;

export function createBrowserAccountStore(storage: Storage = window.localStorage): AccountStore {
  const read = (): AccountHandle[] => {
    const text = storage.getItem(KEY);
    if (!text) return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error("invalid saved account collection");
    return value.map(parseAccountHandle);
  };
  const readRemoved = (): string[] => {
    const text = storage.getItem(REMOVED_KEY);
    if (!text) return [];
    try {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) return [];
      return value.filter((item): item is string => validAccountId(item));
    } catch { return []; }
  };
  const writeRemoved = (values: readonly string[]) => storage.setItem(REMOVED_KEY, JSON.stringify([...new Set(values)].slice(0, MAX_ACCOUNTS)));
  return Object.freeze({
    async list() {
      const removed = new Set(readRemoved());
      return Object.freeze(read().filter(item => !removed.has(item.id)));
    },
    async save(handle: AccountHandle) {
      const parsed = parseAccountHandle(handle);
      writeRemoved(readRemoved().filter(id => id !== parsed.id));
      const records = read().filter(item => item.id !== parsed.id);
      records.unshift(parsed);
      if (records.length > MAX_ACCOUNTS) throw new Error(`saved account limit of ${MAX_ACCOUNTS} reached; export an existing handle before adding another`);
      storage.setItem(KEY, JSON.stringify(records));
    },
    async remove(accountId: string) {
      if (!validAccountId(accountId)) return false;
      const records = read();
      if (!records.some(item => item.id === accountId)) return false;
      writeRemoved([...readRemoved(), accountId]);
      storage.setItem(KEY, JSON.stringify(records.filter(item => item.id !== accountId)));
      return true;
    },
    async isRemoved(accountId: string) {
      return validAccountId(accountId) && readRemoved().includes(accountId);
    }
  });
}

export function parseAccountHandle(value: unknown): AccountHandle {
  if (!value || typeof value !== "object") throw new Error("invalid account handle");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || (record.kind !== "derived" && record.kind !== "recovered")) throw new Error("unsupported account handle");
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 100 || typeof record.label !== "string" || record.label.trim().length === 0 || record.label.length > 80) throw new Error("invalid account identity");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(record.account)) || !Number.isSafeInteger(record.chainId) || Number(record.chainId) < 1) throw new Error("invalid account chain binding");
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(record.credentialId))) throw new Error("invalid public credential id");
  if (!record.publicKey || typeof record.publicKey !== "object" || !bytes32((record.publicKey as Record<string, unknown>).x) || !bytes32((record.publicKey as Record<string, unknown>).y)) throw new Error("invalid passkey public key");
  if (typeof record.rpId !== "string" || record.rpId.length === 0 || record.rpId.length > 253 || typeof record.origin !== "string" || record.origin.length > 2048) throw new Error("invalid passkey origin binding");
  let origin: URL;
  try { origin = new URL(record.origin); } catch { throw new Error("invalid passkey origin binding"); }
  if (origin.origin !== record.origin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw new Error("invalid passkey origin binding");
  if (record.kind === "derived") {
    if (!bytes32(record.salt) || !record.creation || typeof record.creation !== "object") throw new Error("invalid account derivation handle");
    const creation = record.creation as Record<string, unknown>;
    if (!bytes32(creation.guardianRoot) || !Number.isInteger(creation.guardianThreshold) || Number(creation.guardianThreshold) < 0 || Number(creation.guardianThreshold) > 32) throw new Error("invalid account guardian binding");
    if (creation.recoveryModule !== undefined && !address(creation.recoveryModule)) throw new Error("invalid recovery module binding");
  } else if (!address(record.validator)) {
    throw new Error("invalid recovered validator binding");
  }
  return Object.freeze(value) as AccountHandle;
}

function address(value: unknown): boolean { return /^0x[0-9a-fA-F]{40}$/.test(String(value)); }
function bytes32(value: unknown): boolean { return /^0x[0-9a-fA-F]{64}$/.test(String(value)); }
function validAccountId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 100; }
