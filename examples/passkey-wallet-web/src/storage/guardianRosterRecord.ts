import type { GuardianDescriptor } from "@loom/sdk/recovery";
import type { RosterEntry } from "../features/security/guardianPlan";

// Validation for the owner's guardian roster, kept apart from storage so it can
// be exercised on its own. Every field is treated as untrusted: the roster is
// decrypted from local storage, and a record from another account or with a
// malformed descriptor must never be adopted into an account's guardian set.

/** A scheduled change that has not executed yet. Kept separate from `entries`:
 * until the timelock elapses and the change executes, the committed set is
 * still the old one, and presenting the new set as live would misstate who can
 * actually recover the account. */
export interface RosterPending {
  readonly entries: readonly RosterEntry[];
  readonly threshold: number;
  /** When the change was scheduled locally, in milliseconds. */
  readonly scheduledAt: number;
}

export interface RosterRecord {
  readonly version: 1;
  readonly accountId: string;
  readonly setVersion: number;
  readonly entries: readonly RosterEntry[];
  readonly pending?: RosterPending;
}

export function parseRosterRecord(value: unknown, accountId: string): RosterRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guardian roster record is invalid");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("unsupported guardian roster record");
  if (record.accountId !== accountId) throw new Error("guardian roster record belongs to another account");
  if (!Number.isInteger(record.setVersion) || Number(record.setVersion) < 0) throw new Error("guardian roster version is invalid");
  if (!Array.isArray(record.entries) || record.entries.length > 32) throw new Error("guardian roster is invalid");
  const pending = parsePending(record.pending);
  return Object.freeze({
    version: 1,
    accountId,
    setVersion: Number(record.setVersion),
    entries: Object.freeze(record.entries.map(parseRosterEntry)),
    ...(pending ? { pending } : {})
  });
}

function parsePending(value: unknown): RosterPending | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("pending guardian change is invalid");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 32) {
    throw new Error("pending guardian change is invalid");
  }
  const entries = Object.freeze(record.entries.map(parseRosterEntry));
  const threshold = record.threshold;
  if (!Number.isInteger(threshold) || Number(threshold) < 1 || Number(threshold) > entries.length) {
    throw new Error("pending guardian threshold is invalid");
  }
  if (typeof record.scheduledAt !== "number" || !Number.isFinite(record.scheduledAt) || record.scheduledAt <= 0) {
    throw new Error("pending guardian schedule time is invalid");
  }
  return Object.freeze({ entries, threshold: Number(threshold), scheduledAt: Number(record.scheduledAt) });
}

function parseRosterEntry(value: unknown): RosterEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guardian entry is invalid");
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 100) throw new Error("guardian entry id is invalid");
  if (typeof entry.label !== "string" || entry.label.trim().length === 0 || entry.label.length > 80) throw new Error("guardian entry label is invalid");
  return Object.freeze({ id: entry.id, label: entry.label.trim(), descriptor: parseDescriptor(entry.descriptor) });
}

function parseDescriptor(value: unknown): GuardianDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guardian descriptor is invalid");
  const descriptor = value as Record<string, unknown>;
  if (!address(descriptor.verifier) || !bytes32(descriptor.verifierCodeHash)) throw new Error("guardian verifier binding is invalid");
  if (descriptor.salt !== undefined && !bytes32(descriptor.salt)) throw new Error("guardian salt is invalid");
  const base = {
    verifier: descriptor.verifier,
    verifierCodeHash: descriptor.verifierCodeHash,
    ...(descriptor.salt === undefined ? {} : { salt: descriptor.salt })
  } as const;

  if (descriptor.kind === "ecdsa") {
    if (!address(descriptor.address)) throw new Error("guardian address is invalid");
    return Object.freeze({ kind: "ecdsa", address: descriptor.address, ...base }) as GuardianDescriptor;
  }
  if (descriptor.kind === "erc1271") {
    if (!address(descriptor.account)) throw new Error("guardian contract address is invalid");
    return Object.freeze({ kind: "erc1271", account: descriptor.account, ...base }) as GuardianDescriptor;
  }
  if (descriptor.kind === "p256") {
    const key = descriptor.publicKey as Record<string, unknown> | undefined;
    if (!key || !bytes32(key.x) || !bytes32(key.y)) throw new Error("guardian public key is invalid");
    return Object.freeze({ kind: "p256", publicKey: Object.freeze({ x: key.x, y: key.y }), ...base }) as GuardianDescriptor;
  }
  throw new Error("unsupported guardian kind");
}

function address(value: unknown): value is `0x${string}` { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function bytes32(value: unknown): value is `0x${string}` { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
