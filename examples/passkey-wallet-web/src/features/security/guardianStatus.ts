import type { Hex } from "@loom/core";
import { planGuardianChange, type RosterEntry } from "./guardianPlan.ts";

const ZERO_ROOT = `0x${"00".repeat(32)}` as const;

export interface OnChainGuardians {
  readonly root: Hex;
  readonly threshold: number;
  /** Whether the recovery module is installed, so guardians can actually act. */
  readonly recoveryConfigured: boolean;
  /** Binds guardian capabilities to this exact account configuration. */
  readonly configVersion: bigint;
}

export type GuardianStatus =
  /** The account publishes no guardian root: recovery is not set up. */
  | { readonly kind: "unprotected" }
  /** Chain and this device agree; the list can be edited. */
  | { readonly kind: "in-sync"; readonly threshold: number }
  /** The account is guardian-protected but this device holds no list. */
  | { readonly kind: "list-missing"; readonly threshold: number }
  /** This device holds a list that does not rebuild the account's root. */
  | { readonly kind: "list-mismatch"; readonly threshold: number };

/**
 * Does this roster rebuild the account's on-chain guardian root?
 *
 * Each leaf commits to a random per-guardian salt that is never published, so a
 * root can only be reproduced from a roster that carries those salts. A matching
 * root is therefore strong evidence the roster is the real guardian set; it
 * cannot be forged by guessing guardian addresses.
 */
export function rosterMatchesRoot(input: {
  entries: readonly RosterEntry[];
  threshold: number;
  root: Hex;
}): boolean {
  if (input.entries.length === 0) return false;
  try {
    const { set } = planGuardianChange({ current: [], next: input.entries, threshold: input.threshold });
    return set.root.toLowerCase() === input.root.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The account's own state decides whether it is protected — never the local
 * list. A device that has lost its roster must still be told the account is
 * guardian-protected, rather than being shown an empty set-up screen.
 */
export function deriveGuardianStatus(input: {
  onChain: OnChainGuardians | null;
  entries: readonly RosterEntry[];
}): GuardianStatus {
  const onChain = input.onChain;
  if (!onChain || onChain.root === ZERO_ROOT || onChain.threshold === 0) return { kind: "unprotected" };
  if (input.entries.length === 0) return { kind: "list-missing", threshold: onChain.threshold };
  return rosterMatchesRoot({ entries: input.entries, threshold: onChain.threshold, root: onChain.root })
    ? { kind: "in-sync", threshold: onChain.threshold }
    : { kind: "list-mismatch", threshold: onChain.threshold };
}

export interface RosterBackup {
  readonly format: "loom.guardian-roster";
  readonly version: 1;
  readonly account: string;
  readonly chainId: number;
  readonly threshold: number;
  readonly entries: readonly RosterEntry[];
}

export function createRosterBackup(input: {
  account: string;
  chainId: number;
  threshold: number;
  entries: readonly RosterEntry[];
}): RosterBackup {
  return Object.freeze({
    format: "loom.guardian-roster",
    version: 1,
    account: input.account,
    chainId: input.chainId,
    threshold: input.threshold,
    entries: input.entries
  });
}

/**
 * Parse a backup file. Shape only — whether it is the *right* list is decided by
 * rebuilding the root against the chain, not by trusting the file's own claims.
 */
export function parseRosterBackup(value: unknown): RosterBackup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This is not a guardian backup file.");
  const record = value as Record<string, unknown>;
  if (record.format !== "loom.guardian-roster" || record.version !== 1) throw new Error("Unsupported guardian backup format.");
  if (typeof record.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(record.account)) throw new Error("The backup names no valid account.");
  if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) < 1) throw new Error("The backup names no valid chain.");
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 32) throw new Error("The backup holds no guardians.");
  const threshold = record.threshold;
  if (!Number.isInteger(threshold) || Number(threshold) < 1 || Number(threshold) > record.entries.length) {
    throw new Error("The backup's approval threshold is invalid.");
  }
  return Object.freeze({
    format: "loom.guardian-roster",
    version: 1,
    account: record.account,
    chainId: Number(record.chainId),
    threshold: Number(threshold),
    entries: Object.freeze(record.entries as RosterEntry[])
  });
}

/**
 * Accept a backup only when it belongs to this account and rebuilds the root the
 * account actually publishes. This is what makes restoring safe: a wrong or
 * tampered file cannot install itself as the guardian list.
 */
export function verifyRosterBackup(input: {
  backup: RosterBackup;
  account: string;
  chainId: number;
  onChain: OnChainGuardians;
}): { ok: true } | { ok: false; reason: string } {
  const { backup, onChain } = input;
  if (backup.account.toLowerCase() !== input.account.toLowerCase()) {
    return { ok: false, reason: "This backup belongs to a different account." };
  }
  if (backup.chainId !== input.chainId) {
    return { ok: false, reason: "This backup belongs to a different chain." };
  }
  if (backup.threshold !== onChain.threshold) {
    return { ok: false, reason: `The backup expects a ${backup.threshold}-approval threshold, but the account requires ${onChain.threshold}.` };
  }
  if (!rosterMatchesRoot({ entries: backup.entries, threshold: onChain.threshold, root: onChain.root })) {
    return { ok: false, reason: "These guardians do not rebuild this account's guardian root, so this is not its current guardian list." };
  }
  return { ok: true };
}
