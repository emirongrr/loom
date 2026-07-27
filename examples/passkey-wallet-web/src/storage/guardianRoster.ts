import { createEncryptedStore, type EncryptedStore } from "./encryptedStore";
import { parseRosterRecord, type RosterPending } from "./guardianRosterRecord";
import type { RosterEntry } from "../features/security/guardianPlan";

// The account publishes only a guardian root and a threshold. Who the guardians
// are is never on chain, so the owner's wallet keeps its own encrypted roster —
// without it the Merkle tree cannot be rebuilt to add or remove a guardian.
// Losing this roster does not lose the account or its recovery; it loses the
// ability to edit the set from this device.

export interface RosterState {
  /** The set currently committed on chain. */
  readonly entries: readonly RosterEntry[];
  readonly version: number;
  /** A scheduled change that has not executed yet, if any. */
  readonly pending: RosterPending | null;
  readonly corrupt: number;
}

export interface GuardianRoster {
  read(accountId: string): Promise<RosterState>;
  write(accountId: string, input: {
    entries: readonly RosterEntry[];
    version: number;
    pending?: RosterPending | null;
  }): Promise<void>;
}

export function createBrowserGuardianRoster(
  store: EncryptedStore = createEncryptedStore("loom-guardian-roster-v1")
): GuardianRoster {
  return Object.freeze({
    async read(accountId: string): Promise<RosterState> {
      const stored = await store.entries();
      const corrupt = stored.filter(entry => entry.corrupt).length;
      const match = stored.find(entry => entry.key === accountId);
      if (!match || match.corrupt) return { entries: Object.freeze([]), version: 0, pending: null, corrupt };
      try {
        const record = parseRosterRecord(match.value, accountId);
        return { entries: record.entries, version: record.setVersion, pending: record.pending ?? null, corrupt };
      } catch {
        // A roster that fails validation is reported, never silently replaced.
        return { entries: Object.freeze([]), version: 0, pending: null, corrupt: corrupt + 1 };
      }
    },
    async write(accountId: string, input: { entries: readonly RosterEntry[]; version: number; pending?: RosterPending | null }) {
      await store.put(accountId, parseRosterRecord({
        version: 1,
        accountId,
        setVersion: input.version,
        entries: input.entries,
        ...(input.pending ? { pending: input.pending } : {})
      }, accountId));
    }
  });
}
