import type { Address, Hex } from "@loom/core";
import { createGuardianSet, type GuardianDescriptor, type GuardianSet } from "@loom/sdk/recovery";
import { getAddress, isAddress } from "viem";

/** The contract's own bounds on the recovery delay, in seconds. */
export const MIN_DELAY_SECONDS = 259_200;
export const MAX_DELAY_SECONDS = 7_776_000;
export const MAX_GUARDIANS = 32;

/** A guardian as the owner manages it locally: the descriptor plus a name only
 * this device sees. The chain stores neither — it holds a root and a threshold. */
export interface RosterEntry {
  readonly id: string;
  readonly label: string;
  readonly descriptor: GuardianDescriptor;
}

export interface GuardianChangePlan {
  readonly set: GuardianSet;
  readonly threshold: number;
  readonly added: readonly RosterEntry[];
  readonly removed: readonly RosterEntry[];
  readonly kept: readonly RosterEntry[];
  /** True when the resulting root and threshold match what is already on chain. */
  readonly unchanged: boolean;
}

export interface GuardianKindOption {
  readonly kind: "ecdsa" | "erc1271";
  readonly label: string;
  readonly hint: string;
  readonly verifier: Address;
}

/**
 * Build a guardian descriptor from what the owner typed. The verifier's runtime
 * code hash is supplied by the caller after reading it from the chain; the SDK
 * re-checks it before the guardian is ever used, so a wrong value fails closed
 * rather than silently producing an unusable guardian.
 */
export function buildGuardianDescriptor(input: {
  kind: "ecdsa" | "erc1271";
  value: string;
  verifier: Address;
  verifierCodeHash: Hex;
}): GuardianDescriptor {
  const trimmed = input.value.trim();
  if (!isAddress(trimmed)) {
    throw new Error(input.kind === "ecdsa"
      ? "Enter the guardian's Ethereum address."
      : "Enter the guardian contract's address.");
  }
  const account = getAddress(trimmed);
  return input.kind === "ecdsa"
    ? { kind: "ecdsa", address: account, verifier: input.verifier, verifierCodeHash: input.verifierCodeHash }
    : { kind: "erc1271", account, verifier: input.verifier, verifierCodeHash: input.verifierCodeHash };
}

/** The authority a descriptor represents, used to reject the same guardian twice. */
export function guardianAuthority(descriptor: GuardianDescriptor): string {
  switch (descriptor.kind) {
    case "ecdsa": return `ecdsa:${descriptor.address.toLowerCase()}`;
    case "erc1271": return `erc1271:${descriptor.account.toLowerCase()}`;
    default: return `p256:${descriptor.publicKey.x.toLowerCase()}:${descriptor.publicKey.y.toLowerCase()}`;
  }
}

export function describeGuardian(descriptor: GuardianDescriptor): string {
  switch (descriptor.kind) {
    case "ecdsa": return descriptor.address;
    case "erc1271": return descriptor.account;
    default: return "Dedicated passkey";
  }
}

/** Rejects a duplicate before the SDK would, so the message names the guardian. */
export function assertAddable(roster: readonly RosterEntry[], descriptor: GuardianDescriptor): void {
  if (roster.length >= MAX_GUARDIANS) throw new Error(`An account can hold at most ${MAX_GUARDIANS} guardians.`);
  const authority = guardianAuthority(descriptor);
  if (roster.some(entry => guardianAuthority(entry.descriptor) === authority)) {
    throw new Error("That guardian is already in this list.");
  }
}

/**
 * Give every guardian a fresh salt. Salts are rotated on each committed change
 * so the new root cannot be linked to the previous one, and they are assigned
 * here rather than inside the SDK so the exact set can be persisted and rebuilt:
 * a scheduled change must still be executable after the page is reloaded.
 */
export function withFreshSalts(
  entries: readonly RosterEntry[],
  randomBytes: (length: number) => Uint8Array = length => crypto.getRandomValues(new Uint8Array(length))
): readonly RosterEntry[] {
  return Object.freeze(entries.map(entry => Object.freeze({
    ...entry,
    descriptor: Object.freeze({ ...entry.descriptor, salt: randomSalt(randomBytes) })
  })));
}

function randomSalt(randomBytes: (length: number) => Uint8Array): Hex {
  const value = randomBytes(32);
  if (value.length !== 32) throw new Error("a guardian salt must be 32 bytes");
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Turn a draft roster into the set that would be committed, alongside what
 * changed. Any change rotates the root, so removal is real removal rather than
 * hidden retention.
 */
export function planGuardianChange(input: {
  current: readonly RosterEntry[];
  next: readonly RosterEntry[];
  threshold: number;
  onChain?: { root: Hex; threshold: number };
  randomBytes?: (length: number) => Uint8Array;
}): GuardianChangePlan {
  const { next, threshold } = input;
  if (next.length === 0) throw new Error("Add at least one guardian.");
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error("The approval threshold must be at least one.");
  if (threshold > next.length) throw new Error("The threshold cannot exceed the number of guardians.");

  const set = createGuardianSet({
    guardians: next.map(entry => entry.descriptor),
    threshold,
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {})
  });

  const currentAuthorities = new Set(input.current.map(entry => guardianAuthority(entry.descriptor)));
  const nextAuthorities = new Set(next.map(entry => guardianAuthority(entry.descriptor)));
  return Object.freeze({
    set,
    threshold,
    added: next.filter(entry => !currentAuthorities.has(guardianAuthority(entry.descriptor))),
    removed: input.current.filter(entry => !nextAuthorities.has(guardianAuthority(entry.descriptor))),
    kept: next.filter(entry => currentAuthorities.has(guardianAuthority(entry.descriptor))),
    unchanged: input.onChain ? input.onChain.root === set.root && input.onChain.threshold === threshold : false
  });
}

/** A threshold that stays valid as guardians are added or removed. */
export function clampThreshold(threshold: number, guardianCount: number): number {
  if (guardianCount === 0) return 1;
  return Math.min(Math.max(1, threshold), guardianCount);
}

/** The default the wallet suggests: a majority, which needs no single guardian. */
export function suggestedThreshold(guardianCount: number): number {
  if (guardianCount <= 1) return 1;
  return Math.floor(guardianCount / 2) + 1;
}

export function formatDelay(seconds: number): string {
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}
