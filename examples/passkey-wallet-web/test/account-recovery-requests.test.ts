import assert from "node:assert/strict";
import test from "node:test";
import { collectAccountRecoveryRequests } from "../src/features/recovery/accountRecoveryRequests.ts";
import type { RecoverySession } from "../src/features/recovery/recoverySession.ts";

const ACCOUNT = "0xA6B14bA1F2d68a3F444D01619D04888a31dD3f6C" as const;
const OTHER = "0x35C6EBC5F6EDdE9049c37C18a65424F1723f0c54" as const;
const MINE = "0xD79E07D569fD8F5b526a606e5B1d870D55e3C62d" as const;
const THEIRS = "0xB028a14763eC7D2AD533b30100875Fa59Ecb03Bc" as const;

const session = (over: {
  id?: string; account?: string; chainId?: number;
  stage?: RecoverySession["stage"]; responses?: number; validator?: string;
} = {}): RecoverySession => ({
  id: over.id ?? "session-1",
  stage: over.stage ?? "collecting",
  createdAt: 1_700_000_000_000,
  responses: Array.from({ length: over.responses ?? 1 }, () => ({}) as never),
  request: {
    humanCode: "482913",
    chainId: over.chainId ?? 11155111,
    account: (over.account ?? ACCOUNT) as `0x${string}`,
    guardianThreshold: 2,
    newValidator: (over.validator ?? MINE) as `0x${string}`
  }
} as unknown as RecoverySession);

const base = { chainId: 11155111, account: ACCOUNT } as const;

test("an account with nothing underway produces an empty list", () => {
  assert.deepEqual(collectAccountRecoveryRequests({ ...base, sessions: [] }), []);
});

// The panel is scoped to the account being recovered. A session for a different
// wallet appearing here would read as this wallet's recovery.
test("sessions for other accounts and other chains are not this account's requests", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [
      session({ id: "elsewhere", account: OTHER }),
      session({ id: "other-chain", chainId: 1 })
    ]
  });
  assert.deepEqual(requests, []);
});

// The whole point: a request waiting on guardians offers sending it to them,
// not a generic "open".
test("a collecting session offers sending it to guardians", () => {
  const [request] = collectAccountRecoveryRequests({ ...base, sessions: [session({ stage: "collecting" })] });
  assert.equal(request?.next.kind, "open-session");
  if (request?.next.kind !== "open-session") throw new Error("unreachable");
  assert.equal(request.next.label, "Send to guardians");
  assert.equal(request.next.sessionId, "session-1");
  assert.match(request.status, /Collecting approvals/);
  assert.match(request.detail, /1 of 2 guardian approvals/);
  assert.equal(request.primary, true);
});

test("a session past collection opens rather than offering to send it again", () => {
  const [request] = collectAccountRecoveryRequests({
    ...base, sessions: [session({ stage: "ready-to-execute" })]
  });
  if (request?.next.kind !== "open-session") throw new Error("unreachable");
  assert.equal(request.next.label, "Open");
});

test("a finished session is still listed, but never as something to do", () => {
  const [request] = collectAccountRecoveryRequests({
    ...base, sessions: [session({ stage: "completed" })]
  });
  assert.equal(request?.primary, false);
  assert.equal(request?.next.kind, "blocked");
  assert.doesNotMatch(request!.detail, /guardian approvals/);
});

// The case that costs money: the validator is already paid for and live, and
// the only thing missing is the request guardians sign. Offering that directly
// is the difference between finishing and paying to start again.
test("a published validator this device holds offers the guardian request", () => {
  const [request] = collectAccountRecoveryRequests({
    ...base, sessions: [], restoredValidator: MINE, restoredIsPublished: true
  });
  assert.equal(request?.next.kind, "request-approvals");
  assert.match(request!.status, /Needs a request/);
  assert.equal(request?.primary, true);
});

test("a prepared but unpublished validator offers publication instead", () => {
  const [request] = collectAccountRecoveryRequests({
    ...base, sessions: [], restoredValidator: MINE, restoredIsPublished: false
  });
  assert.equal(request?.next.kind, "publish-validator");
  assert.match(request!.status, /Not published/);
});

// One recovery must not appear as two just because it is visible from two
// places. The session already covers this validator.
test("a draft whose session already exists is not listed twice", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [session({ validator: MINE })], restoredValidator: MINE, restoredIsPublished: true
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.next.kind, "open-session");
});

test("a publication this device cannot continue is shown, and says why", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    published: [{ validator: THEIRS, initDataHash: `0x${"11".repeat(32)}`, blockNumber: 11512033n }]
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.next.kind, "blocked");
  assert.match(requests[0]!.detail, /block 11512033/);
  assert.match(requests[0]!.detail, /gas for it is already spent/);
  assert.equal(requests[0]?.primary, false);
});

test("a publication already covered by a session is not repeated", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [session({ validator: MINE })],
    published: [{ validator: MINE, initDataHash: `0x${"11".repeat(32)}`, blockNumber: 11512004n }]
  });
  assert.equal(requests.length, 1);
});

test("an on-chain proposal is reported even with no local session", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    pending: { pending: true, newValidator: THEIRS, status: "delay-active", readyAt: 10n, expiresAt: 20n }
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.status, /Delay running/);
  assert.match(requests[0]!.detail, /guardians have already approved/);
});

// Seen from the chain and from this device, it is still one recovery.
test("an on-chain proposal matching a local session is not listed separately", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [session({ validator: MINE, stage: "delay-active" })],
    pending: { pending: true, newValidator: MINE, status: "delay-active", readyAt: 10n, expiresAt: 20n }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.next.kind, "open-session");
});

test("an empty pending record adds nothing", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    pending: { pending: false, newValidator: THEIRS, status: "none", readyAt: 0n, expiresAt: 0n }
  });
  assert.deepEqual(requests, []);
});

test("addresses match by value, not by casing", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [session({ account: ACCOUNT.toLowerCase() })]
  });
  assert.equal(requests.length, 1);
});
