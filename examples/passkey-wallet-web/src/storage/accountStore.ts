import type { AccountHandle } from "../types";

export interface AccountStore {
  list(): Promise<readonly AccountHandle[]>;
  save(handle: AccountHandle): Promise<void>;
  linkRecovered(handle: Extract<AccountHandle, { readonly kind: "recovered" }>): Promise<AccountHandle>;
}

const KEY = "loom.wallet.accounts.v1";
const MAX_ACCOUNTS = 256;

export function createBrowserAccountStore(storage: Storage = window.localStorage): AccountStore {
  const read = (): AccountHandle[] => {
    const text = storage.getItem(KEY);
    if (!text) return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error("invalid saved account collection");
    return value.map(parseAccountHandle);
  };
  return Object.freeze({
    async list() { return Object.freeze(read()); },
    async save(handle: AccountHandle) {
      const parsed = parseAccountHandle(handle);
      const records = read().filter(item => item.id !== parsed.id);
      records.unshift(parsed);
      if (records.length > MAX_ACCOUNTS) throw new Error(`saved account limit of ${MAX_ACCOUNTS} reached; export an existing handle before adding another`);
      storage.setItem(KEY, JSON.stringify(records));
    },
    async linkRecovered(handle: Extract<AccountHandle, { readonly kind: "recovered" }>) {
      const parsed = parseAccountHandle(handle);
      if (parsed.kind !== "recovered") throw new Error("only a recovered account handle can replace a saved passkey");
      const current = read();
      const previous = current.find(item => sameAccount(item, parsed));
      const linked = parseAccountHandle(previous
        ? { ...parsed, id: previous.id, label: previous.label }
        : parsed);
      const records = current.filter(item => !sameAccount(item, parsed));
      records.unshift(linked);
      if (records.length > MAX_ACCOUNTS) throw new Error(`saved account limit of ${MAX_ACCOUNTS} reached; export an existing handle before adding another`);
      storage.setItem(KEY, JSON.stringify(records));
      return linked;
    }
  });
}

function sameAccount(left: AccountHandle, right: AccountHandle): boolean {
  return left.chainId === right.chainId && left.account.toLowerCase() === right.account.toLowerCase();
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
