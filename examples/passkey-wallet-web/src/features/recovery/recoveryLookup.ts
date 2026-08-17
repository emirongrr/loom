import { keccak256, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";

/**
 * Reading a recovery straight from the chain, starting from nothing but an
 * address.
 *
 * The recovery pages elsewhere in this app work from a session held on the
 * device that started the recovery. That is the right default -- the session
 * holds things the chain never sees -- but it leaves someone who lost that
 * device unable to see whether their recovery is even alive, let alone finish
 * it. The manager's `pendingRecoveries` is public, so the state is readable by
 * anyone; only the *execution arguments* are not.
 *
 * Nothing here signs, submits, or trusts a caller's claim. It classifies what
 * the chain says and reports what would still block execution.
 */

/** The chain's answer, exactly as `pendingRecoveries` returns it. */
export interface PendingRecoveryRecord {
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly configVersion: bigint;
  readonly nonce: bigint;
}

export type RecoveryLookup =
  | { readonly kind: "none" }
  | {
    readonly kind: "delay-active" | "ready" | "expired" | "stale-config";
    readonly record: PendingRecoveryRecord;
    readonly secondsUntilReady: number;
    readonly secondsUntilExpiry: number;
  };

/**
 * A pending record is itself the proof that guardians approved.
 *
 * `proposeRecovery` verifies the threshold against the live root before it
 * writes `readyAt`, so there is no separate "have they signed yet" question to
 * ask the chain. Anything readable here is already past that gate.
 *
 * `stale-config` outranks the timing states on purpose: the account's
 * configuration moved after approval, so `executeRecovery` will revert however
 * good the timing looks. Reporting it as "ready" would send someone to buy gas
 * for a call that cannot succeed.
 */
export function classifyRecoveryLookup(input: {
  readonly record: PendingRecoveryRecord | null;
  readonly liveConfigVersion: bigint;
  readonly nowSeconds: bigint;
}): RecoveryLookup {
  const { record, liveConfigVersion, nowSeconds } = input;
  if (!record || record.readyAt === 0n) return Object.freeze({ kind: "none" as const });

  const secondsUntilReady = Number(record.readyAt - nowSeconds);
  const secondsUntilExpiry = Number(record.expiresAt - nowSeconds);
  const timing = Object.freeze({ record, secondsUntilReady, secondsUntilExpiry });

  if (record.configVersion !== liveConfigVersion) return Object.freeze({ kind: "stale-config" as const, ...timing });
  if (nowSeconds < record.readyAt) return Object.freeze({ kind: "delay-active" as const, ...timing });
  if (nowSeconds > record.expiresAt) return Object.freeze({ kind: "expired" as const, ...timing });
  return Object.freeze({ kind: "ready" as const, ...timing });
}

/**
 * Why this recovery cannot be executed yet, in the order a reader can act on.
 *
 * Empty means the call would be accepted. A non-empty list is not advice to try
 * anyway: every entry here is a condition `executeRecovery` checks itself.
 */
export function executionBlockers(input: {
  readonly lookup: RecoveryLookup;
  readonly hasInitData: boolean;
}): readonly string[] {
  const { lookup, hasInitData } = input;
  const blockers: string[] = [];
  if (lookup.kind === "none") return Object.freeze(["No recovery is pending for this account."]);
  if (lookup.kind === "stale-config") {
    blockers.push(
      "The account configuration changed after the guardians approved, so this request can no longer be executed. It has to be proposed again."
    );
  }
  if (lookup.kind === "delay-active") blockers.push("The on-chain delay has not finished yet.");
  if (lookup.kind === "expired") blockers.push("The execution window closed. The request has to be proposed again.");
  if (!hasInitData) {
    blockers.push(
      "The new validator's initialization data is not available here. Only its hash is on chain, so it has to come from the device that started the recovery."
    );
  }
  return Object.freeze(blockers);
}

/**
 * Check execution arguments against the hashes the manager already stored.
 *
 * `executeRecovery` compares both, so getting this wrong costs a reverted
 * transaction rather than a wrong outcome. Checking here means the button is
 * only offered when the call would actually be accepted, and it is the only
 * thing that can tell a user their pasted init data is the wrong one.
 */
export function verifyExecutionArguments(input: {
  readonly record: PendingRecoveryRecord;
  readonly oldValidators: readonly Address[];
  readonly initData: Hex;
}): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];

  const validatorsHash = keccak256(
    encodeAbiParameters([{ type: "address[]" }], [input.oldValidators.map(address => getAddress(address))])
  );
  if (validatorsHash.toLowerCase() !== input.record.oldValidatorsHash.toLowerCase()) {
    problems.push("The account's current validator set does not match the one this recovery was approved against.");
  }

  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.initData)) {
    problems.push("The initialization data is not valid hex.");
  } else if (keccak256(input.initData).toLowerCase() !== input.record.initDataHash.toLowerCase()) {
    problems.push("The initialization data does not hash to the value this recovery was approved against.");
  }

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/**
 * Pick the execution data this device already holds for a pending recovery.
 *
 * The data is never asked for by hand. It contains the new passkey's public
 * key, and that passkey lives on the device that created it, so someone who
 * cannot produce the data here also cannot use the account afterwards --
 * offering a paste box would suggest a way out that does not exist. What it can
 * do is find the value among the sessions and drafts already stored here, which
 * is the case where finishing the recovery is genuinely possible.
 *
 * Candidates are matched by hash, not by account or label: the hash is what
 * `executeRecovery` compares, so a stale draft for the same account cannot be
 * mistaken for the live one.
 */
export function selectLocalInitData(input: {
  readonly record: PendingRecoveryRecord;
  readonly candidates: readonly Hex[];
}): Hex | null {
  for (const candidate of input.candidates) {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(candidate)) continue;
    if (keccak256(candidate).toLowerCase() === input.record.initDataHash.toLowerCase()) return candidate;
  }
  return null;
}
