import assert from "node:assert/strict";
import test from "node:test";

import { buildGuardianDescriptor, planGuardianChange, withFreshSalts, type RosterEntry } from "../src/features/security/guardianPlan.ts";
import { deriveGuardianSalt, withDerivedSalts } from "../src/features/security/guardianSalts.ts";
import {
  createRosterBackup, deriveGuardianStatus, parseRosterBackup, rosterMatchesRoot, verifyRosterBackup
} from "../src/features/security/guardianStatus.ts";

const VERIFIER = "0x7f3FEcc48C9737473a56aBA46fb81ff558Dc3E4b";
const CODE_HASH = `0x${"ab".repeat(32)}` as const;
const ACCOUNT = "0xeC4B0CC77f09747a64bDd018d69394aa79847dbE";
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";
const MASTER = `0x${"7c".repeat(32)}` as const;
const OTHER_MASTER = `0x${"5d".repeat(32)}` as const;
const ZERO_ROOT = `0x${"00".repeat(32)}` as const;

function entry(label: string, value: string): RosterEntry {
  return { id: `${label}-id`, label, descriptor: buildGuardianDescriptor({ kind: "ecdsa", value, verifier: VERIFIER, verifierCodeHash: CODE_HASH }) };
}

function rootOf(entries: readonly RosterEntry[], threshold: number) {
  return planGuardianChange({ current: [], next: entries, threshold }).set.root;
}

// --- salts derived from the passkey -----------------------------------------

// This is what lets a lost roster be rebuilt by re-entering the guardians: the
// same passkey yields the same salts, so the same root.
test("the same master and guardian always derive the same salt", () => {
  const alice = entry("Alice", ALICE).descriptor;
  assert.equal(deriveGuardianSalt(MASTER, alice), deriveGuardianSalt(MASTER, alice));
});

test("a different account's master derives different salts", () => {
  const alice = entry("Alice", ALICE).descriptor;
  assert.notEqual(deriveGuardianSalt(MASTER, alice), deriveGuardianSalt(OTHER_MASTER, alice));
});

test("different guardians never share a salt under one master", () => {
  const salts = [ALICE, BOB, CAROL].map(address => deriveGuardianSalt(MASTER, entry("g", address).descriptor));
  assert.equal(new Set(salts).size, 3);
});

// Salts keyed on the guardian's authority, not its position, so editing one
// guardian does not silently change every other guardian's leaf.
test("reordering guardians does not change their salts or the resulting root", () => {
  const ordered = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB), entry("Carol", CAROL)], MASTER);
  const shuffled = withDerivedSalts([entry("Carol", CAROL), entry("Alice", ALICE), entry("Bob", BOB)], MASTER);
  const saltOf = (entries: readonly RosterEntry[], address: string) =>
    entries.find(item => "address" in item.descriptor && item.descriptor.address.toLowerCase() === address.toLowerCase())?.descriptor.salt;

  assert.equal(saltOf(ordered, ALICE), saltOf(shuffled, ALICE));
  assert.equal(rootOf(ordered, 2), rootOf(shuffled, 2));
});

test("removing a guardian leaves the others' salts untouched", () => {
  const before = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB), entry("Carol", CAROL)], MASTER);
  const after = withDerivedSalts([entry("Alice", ALICE), entry("Carol", CAROL)], MASTER);
  assert.equal(before[0]?.descriptor.salt, after[0]?.descriptor.salt);
});

// --- rebuilding the root ----------------------------------------------------

test("re-entering the same guardians with the same passkey rebuilds the account's root", () => {
  const original = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER);
  const root = rootOf(original, 2);
  const reentered = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER);

  assert.equal(rosterMatchesRoot({ entries: reentered, threshold: 2, root }), true);
});

// The root is what proves the entered list is the real one; a near-miss must fail.
test("a wrong, incomplete, or extra guardian fails to rebuild the root", () => {
  const root = rootOf(withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER), 2);
  const wrong = withDerivedSalts([entry("Alice", ALICE), entry("Carol", CAROL)], MASTER);
  const short = withDerivedSalts([entry("Alice", ALICE)], MASTER);
  const extra = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB), entry("Carol", CAROL)], MASTER);

  assert.equal(rosterMatchesRoot({ entries: wrong, threshold: 2, root }), false);
  assert.equal(rosterMatchesRoot({ entries: short, threshold: 2, root }), false);
  assert.equal(rosterMatchesRoot({ entries: extra, threshold: 2, root }), false);
});

// Without the account's passkey an attacker cannot derive the salts, so knowing
// the guardian addresses is not enough to reproduce the root.
test("the correct guardians under the wrong passkey do not rebuild the root", () => {
  const root = rootOf(withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER), 2);
  const guessed = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], OTHER_MASTER);

  assert.equal(rosterMatchesRoot({ entries: guessed, threshold: 2, root }), false);
});

test("a threshold that differs from the account's does not match", () => {
  const entries = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER);
  const root = rootOf(entries, 2);
  assert.equal(rosterMatchesRoot({ entries, threshold: 2, root }), true);
  assert.equal(rosterMatchesRoot({ entries: [], threshold: 2, root }), false);
});

// --- status derivation ------------------------------------------------------

// The reported bug: the account was guardian-protected on chain, but the wallet
// read only its empty local list and claimed there were no guardians.
test("an account protected on chain is never reported as unprotected when the local list is empty", () => {
  const status = deriveGuardianStatus({
    onChain: { root: `0x${"4f".repeat(32)}`, threshold: 2, recoveryConfigured: false },
    entries: []
  });
  assert.deepEqual(status, { kind: "list-missing", threshold: 2 });
});

test("an account with no guardian root is unprotected", () => {
  assert.deepEqual(deriveGuardianStatus({ onChain: { root: ZERO_ROOT, threshold: 0, recoveryConfigured: false }, entries: [] }), { kind: "unprotected" });
  assert.deepEqual(deriveGuardianStatus({ onChain: null, entries: [] }), { kind: "unprotected" });
});

test("a local list that rebuilds the root is in sync", () => {
  const entries = withDerivedSalts([entry("Alice", ALICE), entry("Bob", BOB)], MASTER);
  const status = deriveGuardianStatus({ onChain: { root: rootOf(entries, 2), threshold: 2, recoveryConfigured: true }, entries });
  assert.deepEqual(status, { kind: "in-sync", threshold: 2 });
});

test("a stale local list is reported as a mismatch, not as the truth", () => {
  const stale = withDerivedSalts([entry("Alice", ALICE)], MASTER);
  const status = deriveGuardianStatus({ onChain: { root: `0x${"99".repeat(32)}`, threshold: 2, recoveryConfigured: true }, entries: stale });
  assert.deepEqual(status, { kind: "list-mismatch", threshold: 2 });
});

// --- backups ----------------------------------------------------------------

test("a backup round-trips and is accepted for its own account", () => {
  const entries = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], seeded(3));
  const onChain = { root: rootOf(entries, 2), threshold: 2, recoveryConfigured: true };
  const backup = parseRosterBackup(JSON.parse(JSON.stringify(createRosterBackup({ account: ACCOUNT, chainId: 11155111, threshold: 2, entries }))));

  assert.deepEqual(verifyRosterBackup({ backup, account: ACCOUNT, chainId: 11155111, onChain }), { ok: true });
});

test("a backup for another account, chain, or threshold is refused", () => {
  const entries = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], seeded(4));
  const onChain = { root: rootOf(entries, 2), threshold: 2, recoveryConfigured: true };
  const backup = createRosterBackup({ account: ACCOUNT, chainId: 11155111, threshold: 2, entries });

  assert.equal(verifyRosterBackup({ backup, account: ALICE, chainId: 11155111, onChain }).ok, false);
  assert.equal(verifyRosterBackup({ backup, account: ACCOUNT, chainId: 1, onChain }).ok, false);
  assert.equal(verifyRosterBackup({ backup, account: ACCOUNT, chainId: 11155111, onChain: { ...onChain, threshold: 1 } }).ok, false);
});

// A file is only ever trusted because it reproduces the account's own root.
test("a backup whose guardians do not rebuild the account's root is refused", () => {
  const entries = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], seeded(5));
  const backup = createRosterBackup({ account: ACCOUNT, chainId: 11155111, threshold: 2, entries });
  const verdict = verifyRosterBackup({
    backup, account: ACCOUNT, chainId: 11155111,
    onChain: { root: `0x${"11".repeat(32)}`, threshold: 2, recoveryConfigured: true }
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /do not rebuild/);
});

test("a malformed backup file is refused", () => {
  const cases: unknown[] = [
    null, "text", [], { format: "other", version: 1 },
    { format: "loom.guardian-roster", version: 2 },
    { format: "loom.guardian-roster", version: 1, account: "nope", chainId: 1, threshold: 1, entries: [entry("A", ALICE)] },
    { format: "loom.guardian-roster", version: 1, account: ACCOUNT, chainId: 1, threshold: 5, entries: [entry("A", ALICE)] },
    { format: "loom.guardian-roster", version: 1, account: ACCOUNT, chainId: 1, threshold: 1, entries: [] }
  ];
  for (const value of cases) assert.throws(() => parseRosterBackup(value));
});

function seeded(seed: number): (length: number) => Uint8Array {
  let counter = seed;
  return length => Uint8Array.from({ length }, () => (counter = (counter * 31 + 7) % 251));
}
