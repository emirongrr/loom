import type { PasskeyBackupObservation } from "../../types";

export type PasskeyAvailability = "unknown" | "authenticator-bound" | "sync-pending" | "backed-up";

export function classifyPasskeyAvailability(observation?: PasskeyBackupObservation): PasskeyAvailability {
  if (!observation) return "unknown";
  if (!observation.backupEligible) return "authenticator-bound";
  return observation.backedUp ? "backed-up" : "sync-pending";
}

const DISMISSALS_KEY = "loom.wallet.passkey-guidance.v1";

export function passkeyGuidanceDismissed(accountId: string, storage: Storage = window.localStorage): boolean {
  try {
    const value: unknown = JSON.parse(storage.getItem(DISMISSALS_KEY) ?? "[]");
    return Array.isArray(value) && value.includes(accountId);
  } catch { return false; }
}

export function dismissPasskeyGuidance(accountId: string, storage: Storage = window.localStorage): void {
  let current: string[] = [];
  try {
    const value: unknown = JSON.parse(storage.getItem(DISMISSALS_KEY) ?? "[]");
    if (Array.isArray(value)) current = value.filter((item): item is string => typeof item === "string");
  } catch { /* Replace malformed presentation-only state. */ }
  storage.setItem(DISMISSALS_KEY, JSON.stringify([...new Set([...current, accountId])].slice(-256)));
}
