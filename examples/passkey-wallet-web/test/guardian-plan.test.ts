import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAddable, buildGuardianDescriptor, clampThreshold, formatCountdown, guardianAuthority,
  planGuardianChange, suggestedThreshold, withFreshSalts, type RosterEntry
} from "../src/features/security/guardianPlan.ts";
import { parseRosterRecord } from "../src/storage/guardianRosterRecord.ts";

const VERIFIER = "0x7f3FEcc48C9737473a56aBA46fb81ff558Dc3E4b";
const CODE_HASH = `0x${"ab".repeat(32)}` as const;
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";

function entry(label: string, value: string, kind: "ecdsa" | "erc1271" = "ecdsa"): RosterEntry {
  return { id: `${label}-id`, label, descriptor: buildGuardianDescriptor({ kind, value, verifier: VERIFIER, verifierCodeHash: CODE_HASH }) };
}

// Deterministic salts keep the assertions about roots meaningful.
function saltsFrom(seed: number): (length: number) => Uint8Array {
  let counter = seed;
  return length => Uint8Array.from({ length }, () => (counter = (counter * 31 + 7) % 251));
}

test("a guardian address is checksummed and typed", () => {
  const descriptor = buildGuardianDescriptor({ kind: "ecdsa", value: BOB.toLowerCase(), verifier: VERIFIER, verifierCodeHash: CODE_HASH });
  assert.equal(descriptor.kind, "ecdsa");
  assert.equal(guardianAuthority(descriptor), `ecdsa:${BOB.toLowerCase()}`);
});

test("anything that is not an address is refused before it reaches the set", () => {
  for (const value of ["", "alex", "0x123", `${BOB}00`]) {
    assert.throws(() => buildGuardianDescriptor({ kind: "ecdsa", value, verifier: VERIFIER, verifierCodeHash: CODE_HASH }));
  }
});

// The same key in a set would let one person hold two of the approvals.
test("the same guardian cannot be added twice, in any letter case", () => {
  const roster = [entry("Alice", ALICE)];
  assert.throws(
    () => assertAddable(roster, buildGuardianDescriptor({ kind: "ecdsa", value: ALICE.toLowerCase(), verifier: VERIFIER, verifierCodeHash: CODE_HASH })),
    /already in this list/
  );
});

test("the same address as a different guardian kind is a different authority", () => {
  const roster = [entry("Alice", ALICE)];
  assert.doesNotThrow(() => assertAddable(roster, buildGuardianDescriptor({ kind: "erc1271", value: ALICE, verifier: VERIFIER, verifierCodeHash: CODE_HASH })));
});

test("adding a guardian is reported as an addition and rotates the root", () => {
  const current = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], saltsFrom(3));
  const before = planGuardianChange({ current, next: current, threshold: 2 });
  const next = withFreshSalts([...current, entry("Carol", CAROL)], saltsFrom(9));
  const plan = planGuardianChange({ current, next, threshold: 2 });

  assert.deepEqual(plan.added.map(item => item.label), ["Carol"]);
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.kept.length, 2);
  assert.equal(plan.set.guardians.length, 3);
  assert.notEqual(plan.set.root, before.set.root);
});

test("removing a guardian is reported and drops them from the committed set", () => {
  const current = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB), entry("Carol", CAROL)], saltsFrom(5));
  const next = current.filter(item => item.label !== "Bob");
  const plan = planGuardianChange({ current, next, threshold: 2 });

  assert.deepEqual(plan.removed.map(item => item.label), ["Bob"]);
  assert.equal(plan.set.guardians.length, 2);
  assert.equal(plan.added.length, 0);
});

// Salt rotation is what stops a new root from being linkable to the old one.
test("every committed change rotates each guardian's salt", () => {
  const first = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], saltsFrom(2));
  const second = withFreshSalts(first, saltsFrom(11));
  const firstSalts = first.map(item => item.descriptor.salt);
  const secondSalts = second.map(item => item.descriptor.salt);

  assert.ok(firstSalts.every(salt => typeof salt === "string" && /^0x[0-9a-f]{64}$/.test(salt)));
  assert.equal(firstSalts.some((salt, index) => salt === secondSalts[index]), false);
  assert.notEqual(
    planGuardianChange({ current: first, next: first, threshold: 1 }).set.root,
    planGuardianChange({ current: second, next: second, threshold: 1 }).set.root
  );
});

test("a threshold above the guardian count is refused", () => {
  const roster = withFreshSalts([entry("Alice", ALICE)], saltsFrom(1));
  assert.throws(() => planGuardianChange({ current: [], next: roster, threshold: 2 }), /cannot exceed/);
  assert.throws(() => planGuardianChange({ current: [], next: roster, threshold: 0 }), /at least one/);
});

test("an empty guardian list is refused", () => {
  assert.throws(() => planGuardianChange({ current: [], next: [], threshold: 1 }), /at least one guardian/);
});

test("a plan matching the on-chain root and threshold is reported as unchanged", () => {
  const roster = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], saltsFrom(4));
  const plan = planGuardianChange({ current: roster, next: roster, threshold: 2 });
  const same = planGuardianChange({ current: roster, next: roster, threshold: 2, onChain: { root: plan.set.root, threshold: 2 } });
  const different = planGuardianChange({ current: roster, next: roster, threshold: 2, onChain: { root: plan.set.root, threshold: 1 } });

  assert.equal(same.unchanged, true);
  assert.equal(different.unchanged, false);
});

test("the threshold stays valid as the roster shrinks", () => {
  assert.equal(clampThreshold(5, 2), 2);
  assert.equal(clampThreshold(0, 3), 1);
  assert.equal(clampThreshold(2, 3), 2);
});

test("the suggested threshold is a majority", () => {
  assert.equal(suggestedThreshold(1), 1);
  assert.equal(suggestedThreshold(2), 2);
  assert.equal(suggestedThreshold(3), 2);
  assert.equal(suggestedThreshold(5), 3);
});

// The roster is the only copy of who the guardians are, so a record that does not
// belong to this account must never be adopted into it.
test("a stored roster from another account is refused", () => {
  const record = { version: 1, accountId: "11155111:0xaaa", setVersion: 1, entries: [] };
  assert.throws(() => parseRosterRecord(record, "11155111:0xbbb"), /another account/);
});

test("a malformed stored roster entry is refused", () => {
  const base = { version: 1, accountId: "a", setVersion: 1 };
  const cases = [
    { ...base, entries: [{ id: "1", label: "x", descriptor: { kind: "ecdsa", address: "nope", verifier: VERIFIER, verifierCodeHash: CODE_HASH } }] },
    { ...base, entries: [{ id: "1", label: "", descriptor: { kind: "ecdsa", address: ALICE, verifier: VERIFIER, verifierCodeHash: CODE_HASH } }] },
    { ...base, entries: [{ id: "1", label: "x", descriptor: { kind: "unknown", verifier: VERIFIER, verifierCodeHash: CODE_HASH } }] },
    { ...base, entries: [{ id: "1", label: "x", descriptor: { kind: "ecdsa", address: ALICE, verifier: "nope", verifierCodeHash: CODE_HASH } }] },
    { version: 2, accountId: "a", setVersion: 1, entries: [] }
  ];
  for (const value of cases) assert.throws(() => parseRosterRecord(value, "a"));
});

// The countdown is measured against the chain's clock. Rounding down keeps the
// wallet from ever claiming a change is closer to ready than it is.
test("the countdown reports the time left and never rounds up", () => {
  const day = 86_400n;
  assert.equal(formatCountdown(day * 3n, 0n), "3d 0h left");
  assert.equal(formatCountdown(day * 2n + 3_600n * 5n, 0n), "2d 5h left");
  assert.equal(formatCountdown(3_600n * 4n + 1_800n, 0n), "4h 30m left");
  assert.equal(formatCountdown(119n, 0n), "1m left");
  assert.equal(formatCountdown(59n, 0n), "less than a minute left");
});

test("a change whose delay has elapsed reads as ready", () => {
  assert.equal(formatCountdown(100n, 100n), "Ready now");
  assert.equal(formatCountdown(100n, 500n), "Ready now");
});

// A pending change must never be adopted with a threshold its own guardian list
// cannot satisfy, or the account would show a quorum that can never be reached.
test("a pending change with an impossible threshold is refused", () => {
  const roster = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], saltsFrom(8));
  const base = { version: 1, accountId: "a", setVersion: 1, entries: [] };
  const cases = [
    { ...base, pending: { entries: roster, threshold: 3, scheduledAt: 1 } },
    { ...base, pending: { entries: roster, threshold: 0, scheduledAt: 1 } },
    { ...base, pending: { entries: [], threshold: 1, scheduledAt: 1 } },
    { ...base, pending: { entries: roster, threshold: 1, scheduledAt: 0 } },
    { ...base, pending: { entries: roster, threshold: 1 } }
  ];
  for (const value of cases) assert.throws(() => parseRosterRecord(JSON.parse(JSON.stringify(value)), "a"));
});

test("a pending change round-trips separately from the committed set", () => {
  const committed = withFreshSalts([entry("Alice", ALICE)], saltsFrom(7));
  const proposed = withFreshSalts([entry("Alice", ALICE), entry("Bob", BOB)], saltsFrom(12));
  const record = {
    version: 1, accountId: "chain:acct", setVersion: 2, entries: committed,
    pending: { entries: proposed, threshold: 2, scheduledAt: 1_700_000_000_000 }
  };
  const parsed = parseRosterRecord(JSON.parse(JSON.stringify(record)), "chain:acct");

  assert.equal(parsed.entries.length, 1, "the committed set stays the old one while a change is pending");
  assert.equal(parsed.pending?.entries.length, 2);
  assert.equal(parsed.pending?.threshold, 2);
});

test("a roster with no pending change reports none", () => {
  const parsed = parseRosterRecord({ version: 1, accountId: "a", setVersion: 1, entries: [] }, "a");
  assert.equal(parsed.pending, undefined);
});

test("a valid stored roster round-trips", () => {
  const roster = withFreshSalts([entry("Alice", ALICE)], saltsFrom(6));
  const record = { version: 1, accountId: "chain:acct", setVersion: 3, entries: roster };
  const parsed = parseRosterRecord(JSON.parse(JSON.stringify(record)), "chain:acct");

  assert.equal(parsed.setVersion, 3);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]?.label, "Alice");
});
