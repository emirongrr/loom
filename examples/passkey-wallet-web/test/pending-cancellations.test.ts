import assert from "node:assert/strict";
import test from "node:test";
import { describePendingCancellation, distinctProtectedAccounts, protectedAccountsKey } from "../src/features/guardians/pendingCancellations.ts";

const ACCOUNT = "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1" as const;
const MANAGER = "0x9569cae60f775341c0f6c8f70170d85adbfab5f8" as const;
const ROOT = `0x${"31".repeat(32)}` as const;

const capability = (over: Record<string, unknown> = {}) => ({
  chainId: 11155111,
  account: ACCOUNT,
  guardianRoot: ROOT,
  threshold: 3,
  configVersion: "9",
  expiresAt: 2_100_000_000,
  guardian: { kind: "p256", leaf: `0x${"a1".repeat(32)}`, verifier: MANAGER, keyCommitment: `0x${"b2".repeat(32)}`, salt: `0x${"c3".repeat(32)}` },
  proof: [],
  ...over
}) as never;

const live = (over: Record<string, unknown> = {}) => ({
  guardianRoot: ROOT, guardianThreshold: 3, configVersion: 9n, recoveryConfigured: true, ...over
}) as never;

const pending = (over: Record<string, unknown> = {}) => ({
  pending: true,
  oldValidatorsHash: `0x${"11".repeat(32)}`,
  newValidator: "0x8888888888888888888888888888888888888888",
  initDataHash: `0x${"22".repeat(32)}`,
  newGuardianRoot: `0x${"33".repeat(32)}`,
  newGuardianThreshold: 3,
  configVersion: 9n,
  nonce: 4n,
  readyAt: 2_000_000_000n,
  expiresAt: 2_000_604_800n,
  chainTimestamp: 1_999_900_000n,
  ...over
}) as never;

const describe = (over: { live?: unknown; pending?: unknown; capability?: unknown } = {}) =>
  describePendingCancellation({
    capability: (over.capability ?? capability()) as never,
    recoveryManager: MANAGER,
    live: (over.live ?? live()) as never,
    pending: (over.pending ?? pending()) as never,
    nowSeconds: 1_999_900_000
  });

test("a pending recovery becomes a request the guardian can sign, built from chain state", () => {
  const view = describe();
  assert.equal(view?.request.format, "loom.recovery-cancel-request");
  assert.equal(view?.request.account, ACCOUNT);
  assert.equal(view?.request.nonce, "4");
  assert.equal(view?.phase, "delay");
});

// Nothing pending means nothing to stop, and no button offering to.
test("no pending recovery produces nothing", () => {
  assert.equal(describe({ pending: pending({ pending: false }) }), null);
});

test("the phase follows the chain's own clock", () => {
  assert.equal(describe({ pending: pending({ chainTimestamp: 2_000_000_001n }) })?.phase, "executable");
  assert.equal(describe({ pending: pending({ chainTimestamp: 2_000_604_801n }) })?.phase, "expired");
});

// A capability the manager would refuse must not be offered as a button: the
// guardian would sign, hand it over, and only then find out it was worthless.
test("a capability whose root no longer matches offers nothing", () => {
  assert.equal(describe({ live: live({ guardianRoot: `0x${"ff".repeat(32)}` }) }), null);
});

test("a stale threshold or configuration version offers nothing", () => {
  assert.equal(describe({ live: live({ guardianThreshold: 2 }) }), null);
  assert.equal(describe({ live: live({ configVersion: 10n }) }), null);
});

test("an account that no longer has guardian recovery offers nothing", () => {
  assert.equal(describe({ live: live({ recoveryConfigured: false }) }), null);
});

// A signature that outlives the recovery it stops authorises nothing.
test("the request never outlives the recovery", () => {
  const view = describe({ pending: pending({ expiresAt: 1_999_910_000n, chainTimestamp: 1_999_900_000n }) });
  assert.equal(view?.request.expiresAt, 1_999_910_000);
});

test("each protected account appears once, whatever the casing", () => {
  const accounts = distinctProtectedAccounts([
    { capability: capability() },
    { capability: capability({ account: ACCOUNT.toLowerCase() }) },
    { capability: capability({ account: "0x1111111111111111111111111111111111111111" }) }
  ], 11155111);
  assert.equal(accounts.length, 2);
});

test("capabilities for another chain are left out", () => {
  assert.equal(distinctProtectedAccounts([{ capability: capability({ chainId: 1 }) }], 11155111).length, 0);
});

// The discovery effect keys off this string. It was keyed off the array of
// capabilities instead, which is rebuilt on every render, so the effect re-ran
// on every render and its own loading state caused the next one. The list sat
// on "Reading the chain" forever, and the test process died of heap exhaustion
// with every test still reported as passing -- which is why this is asserted
// here, where a failure is visible, rather than left to a component test.
test("the key is stable across equal but freshly built lists", () => {
  const a = [{ capability: capability() }, { capability: capability({ account: "0x1111111111111111111111111111111111111111" }) }];
  const b = [{ capability: capability() }, { capability: capability({ account: "0x1111111111111111111111111111111111111111" }) }];
  assert.notEqual(a, b);
  assert.equal(protectedAccountsKey(a), protectedAccountsKey(b));
});

test("the key does not depend on the order the capabilities arrive in", () => {
  const other = capability({ account: "0x1111111111111111111111111111111111111111" });
  assert.equal(
    protectedAccountsKey([{ capability: capability() }, { capability: other }]),
    protectedAccountsKey([{ capability: other }, { capability: capability() }])
  );
});

test("the key changes when a protected account is added or removed", () => {
  const one = protectedAccountsKey([{ capability: capability() }]);
  const two = protectedAccountsKey([{ capability: capability() }, { capability: capability({ account: "0x1111111111111111111111111111111111111111" }) }]);
  assert.notEqual(one, two);
});
