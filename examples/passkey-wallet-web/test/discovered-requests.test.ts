import assert from "node:assert/strict";
import test from "node:test";
import { createGuardianInvite, createGuardianSet, createRecoveryId } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { classifyDiscoveredRequests } from "../src/features/guardians/discoveredRequests.ts";

const protectedAccount = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const recoveryManager = "0x2222222222222222222222222222222222222222";
const board = "0x6666666666666666666666666666666666666666";
const newValidator = "0x9999999999999999999999999999999999999999";
const verifier = "0x3333333333333333333333333333333333333333";
const chainId = 11_155_111;
const now = 1_900_000_000;
const initDataHash = `0x${"1d".repeat(32)}` as const;
const newGuardianRoot = `0x${"9e".repeat(32)}` as const;

const set = createGuardianSet({
  guardians: [{
    kind: "p256",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    credentialId: "0xab",
    verifier,
    verifierCodeHash: `0x${"a1".repeat(32)}`,
    salt: `0x${"c1".repeat(32)}`
  }],
  threshold: 1
});
const capability = createGuardianInvite({
  set,
  guardianLeaf: set.guardians[0].leaf,
  chainId,
  account: protectedAccount,
  accountAlias: "Protected",
  issuerLabel: "Owner",
  guardianSetVersion: 1,
  configVersion: 4n,
  capabilityId: `0x${"c9".repeat(32)}`,
  expiresAt: 2_000_000_000
});

const validators = ["0x4444444444444444444444444444444444444444"];
const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] v"), [validators]));
const live = {
  guardianRoot: set.root,
  guardianThreshold: 1,
  configVersion: 4n,
  validators,
  recoveryConfigured: true
};

const recoveryId = createRecoveryId({
  account: protectedAccount,
  oldValidatorsHash,
  newValidator,
  initDataHash,
  newGuardianRoot,
  newGuardianThreshold: 1,
  configVersion: 4n,
  nonce: 0n
});

function announcement(overrides = {}) {
  return {
    status: "unverified",
    recoveryId,
    account: protectedAccount,
    recoveryManager,
    oldValidatorsHash,
    newValidator,
    initDataHash,
    newGuardianRoot,
    newGuardianThreshold: 1,
    configVersion: 4n,
    nonce: 0n,
    expiresAt: BigInt(now + 3600),
    blockNumber: 100n,
    blockHash: `0x${"b1".repeat(32)}`,
    logIndex: 0,
    confirmed: true,
    ...overrides
  };
}

function approval(overrides = {}) {
  return {
    status: "unverified",
    recoveryId,
    account: protectedAccount,
    recoveryManager,
    guardianLeaf: set.guardians[0].leaf,
    approval: { verifier, keyCommitment: set.guardians[0].keyCommitment, salt: set.guardians[0].salt, signature: "0xaa", proof: [], leaf: set.guardians[0].leaf },
    blockNumber: 101n,
    blockHash: `0x${"b2".repeat(32)}`,
    logIndex: 0,
    confirmed: true,
    ...overrides
  };
}

function classify(input = {}) {
  return classifyDiscoveredRequests({
    announcements: [announcement()],
    approvals: [],
    capability,
    live,
    recoveryManager,
    board,
    now,
    ...input
  });
}

test("an announcement matching live account state is verified and carries a comparison code", () => {
  const [view] = classify();
  assert.equal(view.trust, "verified");
  assert.equal(view.recoveryId, recoveryId);
  assert.equal(view.newValidator, newValidator);
  assert.ok(view.request, "a verified request must be reviewable");
  assert.match(view.request.humanCode, /^[0-9]{6}$/u, "the guardian needs a code to compare out of band");
  assert.equal(view.issue, undefined);
});

test("an announcement that does not match the live validator set stays merely detected", () => {
  const [view] = classify({
    announcements: [announcement({ oldValidatorsHash: `0x${"ff".repeat(32)}` })]
  });
  assert.equal(view.trust, "detected");
  assert.ok(view.issue, "a detected request must say why it is not verified");
  assert.equal(view.request, undefined, "an unverified request must not be reviewable");
});

test("an announcement bound to a superseded configuration version stays detected", () => {
  const [view] = classify({ live: { ...live, configVersion: 5n } });
  assert.equal(view.trust, "detected");
  assert.ok(view.issue);
});

test("an announcement for another account is discarded entirely", () => {
  const views = classify({
    announcements: [announcement({ account: "0xdddddddddddddddddddddddddddddddddddddddd" })]
  });
  assert.deepEqual(views, []);
});

test("an announcement from a different recovery manager is discarded entirely", () => {
  const views = classify({
    announcements: [announcement({ recoveryManager: "0x8888888888888888888888888888888888888888" })]
  });
  assert.deepEqual(views, []);
});

test("an expired announcement is detected but never reviewable", () => {
  const [view] = classify({ announcements: [announcement({ expiresAt: BigInt(now - 1) })] });
  assert.equal(view.trust, "detected");
  assert.equal(view.request, undefined);
  assert.match(view.issue, /expir/iu);
});

test("an announcement claiming an expiry beyond the format's lifetime fails closed", () => {
  const [view] = classify({ announcements: [announcement({ expiresAt: BigInt(now + 400 * 24 * 3600) })] });
  assert.equal(view.trust, "detected");
  assert.equal(view.request, undefined);
});

test("published approvals are counted against the live threshold", () => {
  const [view] = classify({
    approvals: [approval({ guardianLeaf: `0x${"77".repeat(32)}`, confirmed: true })]
  });
  assert.equal(view.publishedApprovals, 1);
  assert.equal(view.threshold, 1);
});

test("an unconfirmed approval is not counted as progress", () => {
  const [view] = classify({
    approvals: [approval({ guardianLeaf: `0x${"77".repeat(32)}`, confirmed: false })]
  });
  assert.equal(view.publishedApprovals, 0);
});

test("this guardian's own published approval is reported so the dialog can say so", () => {
  const [view] = classify({ approvals: [approval()] });
  assert.equal(view.alreadyPublishedByMe, true);
  const [fresh] = classify();
  assert.equal(fresh.alreadyPublishedByMe, false);
});

test("an approval with no announcement still surfaces that a recovery is under way", () => {
  const views = classify({
    announcements: [],
    approvals: [approval({ recoveryId: `0x${"e5".repeat(32)}`, guardianLeaf: `0x${"77".repeat(32)}` })]
  });
  assert.equal(views.length, 1);
  assert.equal(views[0].trust, "detected");
  assert.equal(views[0].request, undefined);
  assert.equal(views[0].publishedApprovals, 1);
});

test("an account with recovery switched off yields nothing reviewable", () => {
  const [view] = classify({ live: { ...live, recoveryConfigured: false } });
  assert.equal(view.trust, "detected");
  assert.equal(view.request, undefined);
});
