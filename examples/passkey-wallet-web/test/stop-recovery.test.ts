import assert from "node:assert/strict";
import test from "node:test";
import { humanDuration, planStopRecovery, preferredRoute, RECOVERY_DELAY_SECONDS } from "../src/features/recovery/stopRecovery.ts";

const VALIDATOR = "0x8888888888888888888888888888888888888888" as const;
const READY = 2_000_000_000n;
const EXPIRES = READY + 604_800n;

const plan = (over: Partial<Parameters<typeof planStopRecovery>[0]> = {}) => planStopRecovery({
  newValidator: VALIDATOR,
  readyAt: READY,
  expiresAt: EXPIRES,
  guardianThreshold: 3,
  nowSeconds: READY - 86_400n,
  accountAvailable: true,
  collectedGuardians: 0,
  ...over
});

test("before the delay passes the recovery is pending, not executable", () => {
  assert.equal(plan().phase, "delay");
  assert.match(plan().remaining, /Executable in 1 day/);
});

test("after the delay it is executable, and the countdown switches to the closing window", () => {
  const now = READY + 3600n;
  assert.equal(plan({ nowSeconds: now }).phase, "executable");
  assert.match(plan({ nowSeconds: now }).remaining, /Window closes in/);
});

// An expired recovery still matters: it holds the slot, and a pending one
// blocks a new proposal -- including one the owner wants.
test("an expired recovery still says why cancelling it matters", () => {
  const expired = plan({ nowSeconds: EXPIRES + 1n });
  assert.equal(expired.phase, "expired");
  assert.match(expired.urgency, /still holds the recovery slot/);
  assert.match(expired.urgency, /No new recovery can be proposed/);
});

// ADR-0023: the account alone must never be able to cancel, or a stolen key
// could block the guardians trying to take the account back.
test("the account route still needs guardians, one fewer than the threshold", () => {
  const route = plan().routes.find(entry => entry.id === "account-and-guardians");
  assert.equal(route?.guardiansNeeded, 2);
  assert.equal(route?.satisfied, false);
});

test("the guardian-only route asks for the full threshold", () => {
  const route = plan().routes.find(entry => entry.id === "guardians-only");
  assert.equal(route?.guardiansNeeded, 3);
});

// At a threshold of one the account route asks for the same guardian as the
// other one, and for the account on top. Offering it would describe one thing
// twice, and steer the reader to the harder of two identical outcomes.
test("a threshold of one collapses the two routes, and the account one steps aside", () => {
  const routes = plan({ guardianThreshold: 1 }).routes;
  const withAccount = routes.find(entry => entry.id === "account-and-guardians");
  assert.equal(withAccount?.guardiansNeeded, 1);
  assert.equal(withAccount?.available, false);
  assert.equal(withAccount?.satisfied, false);
  assert.equal(preferredRoute(plan({ guardianThreshold: 1 })).id, "guardians-only");
});

test("enough signatures satisfy the route they were collected for", () => {
  const routes = plan({ collectedGuardians: 2 }).routes;
  assert.equal(routes.find(entry => entry.id === "account-and-guardians")?.satisfied, true);
  assert.equal(routes.find(entry => entry.id === "guardians-only")?.satisfied, false);
});

// The owner reading this may be the one whose key is gone. The route that does
// not need the account must stay reachable.
test("a locked account does not satisfy the account route, and the other stays available", () => {
  const routes = plan({ accountAvailable: false, collectedGuardians: 3 }).routes;
  assert.equal(routes.find(entry => entry.id === "account-and-guardians")?.satisfied, false);
  assert.equal(routes.find(entry => entry.id === "guardians-only")?.available, true);
  assert.equal(preferredRoute(plan({ accountAvailable: false })).id, "guardians-only");
});

test("with the account open the shorter route is offered first", () => {
  assert.equal(preferredRoute(plan()).id, "account-and-guardians");
});

test("the timeline places the proposal one delay before it becomes executable", () => {
  const proposed = plan().milestones.find(entry => entry.id === "proposed");
  assert.equal(proposed?.at, READY - RECOVERY_DELAY_SECONDS);
  assert.equal(proposed?.reached, true);
});

test("milestones not yet reached say so", () => {
  const milestones = plan().milestones;
  assert.equal(milestones.find(entry => entry.id === "executable")?.reached, false);
  assert.equal(milestones.find(entry => entry.id === "expires")?.reached, false);
});

test("durations read in the units a person would use", () => {
  assert.equal(humanDuration(90n), "1 minute(s)");
  assert.equal(humanDuration(7200n), "2 hour(s)");
  assert.equal(humanDuration(172_800n), "2 day(s)");
  assert.equal(humanDuration(176_400n), "2 day(s), 1 hour(s)");
  assert.equal(humanDuration(0n), "moments");
});

// Reported from the running app: a guardian's signature had been collected and
// there was no button to send it. At a threshold of one the account route steps
// aside, so the only satisfied route was the guardian-only one -- which the page
// offered as a copied transaction and nothing else, leaving someone holding a
// sufficient set of signatures with no way to use them.
const readyRoute = (over: Parameters<typeof planStopRecovery>[0] extends infer T ? Partial<T> : never) => {
  const routes = plan(over).routes;
  return routes[0]!.satisfied ? "account-and-guardians" : routes[1]!.satisfied ? "guardians-only" : null;
};

test("one guardian at a threshold of one is enough to send, by the guardian-only route", () => {
  assert.equal(readyRoute({ guardianThreshold: 1, collectedGuardians: 1 }), "guardians-only");
});

test("no signatures means no route is ready", () => {
  assert.equal(readyRoute({ guardianThreshold: 1, collectedGuardians: 0 }), null);
});

test("with the account open and enough signatures the shorter route wins", () => {
  assert.equal(readyRoute({ guardianThreshold: 3, collectedGuardians: 2 }), "account-and-guardians");
});

test("the full threshold without the account is ready even when the account is locked", () => {
  assert.equal(readyRoute({ guardianThreshold: 3, collectedGuardians: 3, accountAvailable: false }), "guardians-only");
});

test("a partial set satisfies neither route", () => {
  assert.equal(readyRoute({ guardianThreshold: 3, collectedGuardians: 1 }), null);
});
