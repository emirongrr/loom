import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStanding, describeStanding } from "../src/features/guardians/capabilityStanding.ts";

const ACCOUNT = "0x00000000000000000000000000000000000000A1" as const;
const ROOT = `0x${"11".repeat(32)}` as const;
const OTHER_ROOT = `0x${"22".repeat(32)}` as const;
const NOW = 1_700_000_000;

const capability = (over: Partial<Parameters<typeof capabilityStanding>[0]["capability"]> = {}) => ({
  account: ACCOUNT, guardianRoot: ROOT, threshold: 2, configVersion: "1", expiresAt: NOW + 86_400, ...over
});
const live = (over: Partial<Parameters<typeof capabilityStanding>[0]["live"]> = {}) => ({
  guardianRoot: ROOT, guardianThreshold: 2, configVersion: 1n, recoveryConfigured: true, ...over
});

test("a capability matching the account's published set is in force", () => {
  const standing = capabilityStanding({ capability: capability(), live: live(), nowSeconds: NOW });
  assert.equal(standing.kind, "current");
  assert.equal(describeStanding(standing).tone, "good");
});

test("a rotated guardian set supersedes the capability issued against the old one", () => {
  const standing = capabilityStanding({ capability: capability(), live: live({ guardianRoot: OTHER_ROOT }), nowSeconds: NOW });
  assert.equal(standing.kind, "superseded");
  assert.match(describeStanding(standing).detail, /new invitation/u);
});

test("a moved threshold supersedes it even when the root still matches", () => {
  const standing = capabilityStanding({ capability: capability(), live: live({ guardianThreshold: 3 }), nowSeconds: NOW });
  assert.equal(standing.kind, "superseded");
  // Named exactly, because "the set changed" would send the guardian looking
  // for a rotation that did not happen.
  assert.match(standing.kind === "superseded" ? standing.detail : "", /3 approvals, not 2/u);
});

test("a replaced configuration version supersedes it", () => {
  const standing = capabilityStanding({ capability: capability(), live: live({ configVersion: 2n }), nowSeconds: NOW });
  assert.equal(standing.kind, "superseded");
});

test("expiry is decided before the chain, so an expired one is not called superseded", () => {
  const standing = capabilityStanding({
    capability: capability({ expiresAt: NOW - 1 }),
    live: live({ guardianRoot: OTHER_ROOT }),
    nowSeconds: NOW
  });
  assert.equal(standing.kind, "expired");
});

test("an account with recovery switched off has nothing to approve", () => {
  const standing = capabilityStanding({ capability: capability(), live: live({ recoveryConfigured: false }), nowSeconds: NOW });
  assert.equal(standing.kind, "recovery-off");
});

test("an unreadable account is never described as a fault in the capability", () => {
  const described = describeStanding({ kind: "unreadable", detail: "The account could not be read." });
  assert.equal(described.label, "Not checked");
  assert.match(described.detail, /could not ask the account/u);
});
