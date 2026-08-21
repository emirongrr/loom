import assert from "node:assert/strict";
import test from "node:test";
import { describePendingRecovery } from "../src/features/wallet/pendingRecoveryWarning.ts";

const VALIDATOR = "0x8A2eB4eC44C00A479cAefFFf988D2D511705c583" as const;
const base = { pending: true, newValidator: VALIDATOR, guardianThreshold: 2 } as const;

test("an account with no recovery against it is told nothing", () => {
  const notice = describePendingRecovery({ ...base, pending: false, readyAt: 0n, expiresAt: 0n, nowSeconds: 100n });
  assert.equal(notice.kind, "none");
});

test("a recovery still in its delay says when it becomes executable", () => {
  const notice = describePendingRecovery({ ...base, readyAt: 200_000n, expiresAt: 800_000n, nowSeconds: 100_000n });
  if (notice.kind !== "pending") throw new Error("unreachable");
  assert.equal(notice.urgency, "delay");
  assert.match(notice.detail, /day\(s\)/);
  assert.match(notice.detail, /this wallet's key stops working/);
});

test("a recovery past its delay is urgent and says so", () => {
  const notice = describePendingRecovery({ ...base, readyAt: 100n, expiresAt: 800_000n, nowSeconds: 200n });
  if (notice.kind !== "pending") throw new Error("unreachable");
  assert.equal(notice.urgency, "executable");
  assert.match(notice.detail, /right now|act now/i);
});

// An expired recovery cannot take the account, but it still holds the slot --
// which blocks the owner's own recovery, so silence would be wrong.
test("an expired recovery still says it occupies the slot", () => {
  const notice = describePendingRecovery({ ...base, readyAt: 100n, expiresAt: 200n, nowSeconds: 900n });
  if (notice.kind !== "pending") throw new Error("unreachable");
  assert.equal(notice.urgency, "expired");
  assert.match(notice.detail, /no new recovery can be proposed/);
});

// The owner cannot cancel alone (ADR-0023). Telling them otherwise would send
// them to a button that cannot work while the clock runs.
test("cancellation is described as needing guardians, never the owner alone", () => {
  const notice = describePendingRecovery({ ...base, readyAt: 200n, expiresAt: 800n, nowSeconds: 100n });
  if (notice.kind !== "pending") throw new Error("unreachable");
  assert.match(notice.cancellation, /1 of your guardians/);
  assert.match(notice.cancellation, /2 guardians without this wallet/);
  assert.match(notice.cancellation, /cannot cancel a recovery alone/);
});

test("a threshold of one still names at least one helper", () => {
  const notice = describePendingRecovery({ ...base, guardianThreshold: 1, readyAt: 200n, expiresAt: 800n, nowSeconds: 100n });
  if (notice.kind !== "pending") throw new Error("unreachable");
  assert.match(notice.cancellation, /1 of your guardians/);
});
