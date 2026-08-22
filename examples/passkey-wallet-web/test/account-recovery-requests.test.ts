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
    ...base, sessions: [], restored: [{ validator: MINE, published: true }]
  });
  assert.equal(request?.next.kind, "request-approvals");
  assert.match(request!.status, /Needs a request/);
  assert.equal(request?.primary, true);
});

test("a prepared but unpublished validator offers publication instead", () => {
  const [request] = collectAccountRecoveryRequests({
    ...base, sessions: [], restored: [{ validator: MINE, published: false }]
  });
  assert.equal(request?.next.kind, "publish-validator");
  assert.match(request!.status, /Not published/);
});

// One recovery must not appear as two just because it is visible from two
// places. The session already covers this validator.
test("a draft whose session already exists is not listed twice", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [session({ validator: MINE })], restored: [{ validator: MINE, published: true }]
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

// Found on a devnet with a real proposal: the validator was both published and
// proposed, and the publication claimed it first -- so the panel reported
// "published elsewhere, nothing you can do" about a recovery the guardians had
// already approved and that only needed its delay.
test("a proposed recovery outranks the publication of the same validator", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    published: [{ validator: THEIRS, initDataHash: `0x${"11".repeat(32)}`, blockNumber: 17n }],
    pending: { pending: true, newValidator: THEIRS, status: "delay-active", readyAt: 10n, expiresAt: 20n }
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.title, /proposed on chain/);
  assert.match(requests[0]!.status, /Delay running/);
});

// Reported from the running app: two drafts, both valid, and the restore loop
// stopped at the first. The second publication was then described as belonging
// to another device, when the device held its draft all along.
test("every held draft is listed, not just the first", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    restored: [{ validator: MINE, published: true }, { validator: THEIRS, published: true }]
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.next.kind, "request-approvals");
  assert.equal(requests[0]?.primary, true);
});

// Owning two is not the same as being able to use two: the recovery nonce
// admits one pending request, so the second is held and unusable at once.
test("a second held validator says it cannot also be used", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    restored: [{ validator: MINE, published: true }, { validator: THEIRS, published: true }]
  });
  assert.equal(requests[1]?.next.kind, "blocked");
  assert.equal(requests[1]?.primary, false);
  assert.match(requests[1]!.detail, /Only one recovery can be proposed/);
  assert.match(requests[1]!.detail, /gas unrecoverable/);
});

// A held draft covers its publication; the publication list must not repeat it
// as something no device can continue.
test("a publication covered by a held draft is not also called unreachable", () => {
  const requests = collectAccountRecoveryRequests({
    ...base, sessions: [],
    restored: [{ validator: THEIRS, published: true }],
    published: [{ validator: THEIRS, initDataHash: `0x${"11".repeat(32)}`, blockNumber: 11512033n }]
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.next.kind, "request-approvals");
});

// Reported from the running app: "Continue to guardian approvals" made a new
// request every time it was pressed, five for one validator. Each rotates to a
// fresh guardian set, so their digests differ -- an approval collected for one
// does not verify against another -- and the recovery nonce admits a single
// pending request, so only one could ever be proposed.
test("a second live request for one validator is marked as a duplicate", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [
      session({ id: "first", validator: MINE, stage: "collecting", responses: 1 }),
      session({ id: "second", validator: MINE, stage: "request-created", responses: 0 })
    ]
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.next.kind, "open-session");
  assert.equal(requests[0]?.primary, true);
  assert.equal(requests[1]?.status, "Duplicate");
  assert.equal(requests[1]?.next.kind, "discard-session");
  assert.equal(requests[1]?.primary, false);
  assert.match(requests[1]!.detail, /does not verify against another/);
});

// The first is the one to keep: any approvals already gathered belong to it.
test("the duplicate offered for discard is the later one, not the one holding approvals", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [
      session({ id: "keep", validator: MINE, responses: 2 }),
      session({ id: "drop", validator: MINE, responses: 0 })
    ]
  });
  if (requests[1]?.next.kind !== "discard-session") throw new Error("unreachable");
  assert.equal(requests[1].next.sessionId, "drop");
});

// Different validators are different recoveries, not duplicates of each other.
test("requests for different validators are not duplicates", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [session({ id: "a", validator: MINE }), session({ id: "b", validator: THEIRS })]
  });
  assert.equal(requests.filter(entry => entry.next.kind === "discard-session").length, 0);
});

// A finished request does not make a new one a duplicate: there is nothing left
// to collide with.
test("a closed request does not block a fresh one for the same validator", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [
      session({ id: "old", validator: MINE, stage: "expired" }),
      session({ id: "new", validator: MINE, stage: "collecting" })
    ]
  });
  assert.equal(requests.filter(entry => entry.next.kind === "discard-session").length, 0);
  assert.equal(requests[1]?.primary, true);
});

// Reported from the running app: the recovery was proposed, the delay was
// counting down, and the panel still said "Ready to send · 0 of 2 approvals"
// and offered to send it to guardians. The manager refuses to record a proposal
// below the threshold, so the chain had already proved those approvals existed.
test("a proposed recovery is not offered for sending, whatever the local record says", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [session({ validator: MINE, stage: "request-created", responses: 0 })],
    pending: { pending: true, newValidator: MINE, status: "delay-active", readyAt: 10n, expiresAt: 20n }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.status, "Delay running");
  if (requests[0]?.next.kind !== "open-session") throw new Error("unreachable");
  assert.equal(requests[0].next.label, "Open");
  assert.doesNotMatch(requests[0]!.detail, /guardian approvals/);
});

// The chain owning one fact does not make a stale local record a duplicate of
// itself: there is one recovery here, and it is the proposed one.
test("a proposed session is never marked a duplicate of itself", () => {
  const requests = collectAccountRecoveryRequests({
    ...base,
    sessions: [session({ id: "a", validator: MINE }), session({ id: "b", validator: MINE })],
    pending: { pending: true, newValidator: MINE, status: "ready", readyAt: 10n, expiresAt: 20n }
  });
  assert.equal(requests.filter(entry => entry.status === "Duplicate").length, 0);
  assert.equal(requests[0]?.status, "Ready to execute");
});
