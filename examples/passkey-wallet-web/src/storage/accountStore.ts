import type { AccountHandle } from "../types";

export interface AccountStoreIssue {
  /** Position in the stored collection, so a report can name which entry. */
  readonly index: number;
  readonly message: string;
}

export interface AccountStoreSnapshot {
  readonly accounts: readonly AccountHandle[];
  readonly issues: readonly AccountStoreIssue[];
}

export interface AccountStore {
  list(): Promise<readonly AccountHandle[]>;
  /** `list` plus what could not be read, for a screen that should say so. */
  inspect(): Promise<AccountStoreSnapshot>;
  save(handle: AccountHandle): Promise<void>;
  remove(accountId: string): Promise<boolean>;
  isRemoved(accountId: string): Promise<boolean>;
  linkRecovered(handle: Extract<AccountHandle, { readonly kind: "recovered" }>): Promise<AccountHandle>;
}

const KEY = "loom.wallet.accounts.v1";
const REMOVED_KEY = "loom.wallet.accounts.removed.v1";
const MAX_ACCOUNTS = 256;

interface StoredAccounts {
  readonly handles: AccountHandle[];
  /** Entries this build could not parse, kept verbatim so a write preserves them. */
  readonly unreadable: unknown[];
  readonly issues: AccountStoreIssue[];
}

export function createBrowserAccountStore(storage: Storage = window.localStorage): AccountStore {
  // One unreadable entry used to reject the whole read, so a single damaged --
  // or simply newer -- record hid every healthy wallet the user had. The sibling
  // removed-wallet list already refuses to behave that way, and so does the
  // guardian vault, which reports what it could not decrypt alongside what it
  // could. This is that shape.
  //
  // Unreadable entries are carried through writes rather than dropped. A record
  // written by a later version of this wallet is unreadable here and perfectly
  // valid there; deleting it on the next save would turn a version skew into
  // data loss.
  const read = (): StoredAccounts => {
    const text = storage.getItem(KEY);
    if (!text) return { handles: [], unreadable: [], issues: [] };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // The whole blob is unrecoverable, so there are no individual entries to
      // preserve. Report it and start clean rather than refusing to work.
      return { handles: [], unreadable: [], issues: [{ index: -1, message: "saved wallet list is not readable" }] };
    }
    if (!Array.isArray(value)) {
      return { handles: [], unreadable: [], issues: [{ index: -1, message: "saved wallet list is not a collection" }] };
    }
    const handles: AccountHandle[] = [];
    const unreadable: unknown[] = [];
    const issues: AccountStoreIssue[] = [];
    for (const [index, entry] of value.slice(0, MAX_ACCOUNTS).entries()) {
      try {
        handles.push(parseAccountHandle(entry));
      } catch (error) {
        unreadable.push(entry);
        issues.push({ index, message: error instanceof Error ? error.message : "unreadable saved wallet" });
      }
    }
    if (value.length > MAX_ACCOUNTS) {
      // Do not parse beyond the bounded collection, but keep every tail entry
      // in the write-preservation set. Otherwise updating a valid handle could
      // silently truncate a newer or damaged oversized collection.
      for (let index = MAX_ACCOUNTS; index < value.length; index += 1) {
        unreadable.push(value[index]);
      }
      issues.push({ index: MAX_ACCOUNTS, message: `saved wallet list exceeds ${MAX_ACCOUNTS} entries` });
    }
    return { handles, unreadable, issues };
  };
  const write = (handles: readonly AccountHandle[], unreadable: readonly unknown[]) => {
    if (handles.length + unreadable.length > MAX_ACCOUNTS) {
      throw new Error(`saved account limit of ${MAX_ACCOUNTS} reached; export an existing handle before adding another`);
    }
    storage.setItem(KEY, JSON.stringify([...handles, ...unreadable]));
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
  const visible = (): AccountStoreSnapshot => {
    const stored = read();
    const removed = new Set(readRemoved());
    return Object.freeze({
      accounts: Object.freeze(stored.handles.filter(item => !removed.has(item.id))),
      issues: Object.freeze(stored.issues)
    });
  };
  return Object.freeze({
    async list() {
      return visible().accounts;
    },
    async inspect() {
      return visible();
    },
    async save(handle: AccountHandle) {
      const parsed = parseAccountHandle(handle);
      const stored = read();
      write([parsed, ...stored.handles.filter(item => item.id !== parsed.id)], stored.unreadable);
      // Clear the tombstone only after the account write succeeds. Validation,
      // quota, or storage failures must not partially unhide a removed wallet.
      writeRemoved(readRemoved().filter(id => id !== parsed.id));
    },
    async remove(accountId: string) {
      if (!validAccountId(accountId)) return false;
      const stored = read();
      if (!stored.handles.some(item => item.id === accountId)) return false;
      writeRemoved([...readRemoved(), accountId]);
      write(stored.handles.filter(item => item.id !== accountId), stored.unreadable);
      return true;
    },
    async isRemoved(accountId: string) {
      return validAccountId(accountId) && readRemoved().includes(accountId);
    },
    async linkRecovered(handle: Extract<AccountHandle, { readonly kind: "recovered" }>) {
      const parsed = parseAccountHandle(handle);
      if (parsed.kind !== "recovered") throw new Error("only a recovered account handle can replace a saved passkey");
      const stored = read();
      const previous = stored.handles.find(item => sameAccount(item, parsed));
      const linked = parseAccountHandle(previous
        ? { ...parsed, id: previous.id, label: previous.label }
        : parsed);
      write([linked, ...stored.handles.filter(item => !sameAccount(item, parsed))], stored.unreadable);
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
function validAccountId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 100; }
