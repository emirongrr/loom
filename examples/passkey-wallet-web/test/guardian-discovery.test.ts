import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryIntentBoardAbi } from "@loom/core/abi";
import { createGuardianInvite, createGuardianSet, createRecoveryId } from "@loom/sdk/recovery";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbiParameters } from "viem";
import { discoverGuardianRecoveryRequests } from "../src/features/guardians/guardianDiscovery.ts";

const protectedAccount = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const otherProtected = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const board = "0x6666666666666666666666666666666666666666";
const recoveryManager = "0x2222222222222222222222222222222222222222";
const newValidator = "0x9999999999999999999999999999999999999999";
const verifier = "0x3333333333333333333333333333333333333333";
const chainId = 11_155_111;
const now = 1_900_000_000;
const initDataHash = `0x${"1d".repeat(32)}` as const;
const newGuardianRoot = `0x${"9e".repeat(32)}` as const;
const validators = ["0x4444444444444444444444444444444444444444"];
const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] v"), [validators]));

function capabilityFor(account: string, salt: string, chain = chainId) {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256",
      publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
      credentialId: "0xab",
      verifier,
      verifierCodeHash: `0x${"a1".repeat(32)}`,
      salt: `0x${salt.repeat(32)}`
    }],
    threshold: 1
  });
  return createGuardianInvite({
    set, guardianLeaf: set.guardians[0].leaf, chainId: chain, account,
    accountAlias: "Protected", issuerLabel: "Owner", guardianSetVersion: 1, configVersion: 4n,
    capabilityId: `0x${salt.repeat(32)}`, expiresAt: 2_000_000_000
  });
}

const capability = capabilityFor(protectedAccount, "c1");
const liveState = {
  guardianRoot: capability.guardianRoot,
  guardianThreshold: 1,
  configVersion: 4n,
  validators,
  recoveryConfigured: true
};

const recoveryId = createRecoveryId({
  account: protectedAccount, oldValidatorsHash, newValidator, initDataHash,
  newGuardianRoot, newGuardianThreshold: 1, configVersion: 4n, nonce: 0n
});

const ANNOUNCE_DATA = parseAbiParameters(
  "address recoveryManager, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce, uint48 expiresAt"
);
const APPROVAL_DATA = parseAbiParameters(
  "address recoveryManager, address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof"
);

function announcementLog(overrides: Record<string, unknown> = {}) {
  const o = { blockNumber: 90n, blockHash: `0x${"b0".repeat(32)}`, logIndex: 0, ...overrides };
  return {
    address: board,
    topics: encodeEventTopics({ abi: RecoveryIntentBoardAbi, eventName: "RecoveryAnnounced", args: { account: protectedAccount, recoveryId } }),
    data: encodeAbiParameters(ANNOUNCE_DATA, [recoveryManager, oldValidatorsHash, newValidator, initDataHash, newGuardianRoot, 1, 4n, 0n, BigInt(now + 3600)]),
    transactionHash: `0x${"ab".repeat(32)}`, removed: false, ...o
  };
}

function approvalLog(overrides: Record<string, unknown> = {}) {
  const o = { blockNumber: 95n, blockHash: `0x${"b1".repeat(32)}`, logIndex: 0, ...overrides };
  return {
    address: board,
    topics: encodeEventTopics({
      abi: RecoveryIntentBoardAbi, eventName: "RecoveryApprovalPublished",
      args: { account: protectedAccount, recoveryId, guardianLeaf: `0x${"77".repeat(32)}` }
    }),
    data: encodeAbiParameters(APPROVAL_DATA, [recoveryManager, verifier, `0x${"dd".repeat(32)}`, `0x${"ef".repeat(32)}`, "0xaabb", []]),
    transactionHash: `0x${"ac".repeat(32)}`, removed: false, ...o
  };
}

function transport(logs: readonly unknown[], latest = 200n) {
  return {
    async getBlockNumber() { return latest; },
    async getLogs(query: { fromBlock: bigint; toBlock: bigint }) {
      return (logs as { blockNumber: bigint }[]).filter(l => l.blockNumber >= query.fromBlock && l.blockNumber <= query.toBlock);
    }
  };
}

const inspectLive = async () => liveState;

function run(overrides: Record<string, unknown> = {}) {
  return discoverGuardianRecoveryRequests({
    capabilities: [capability], board, recoveryManager, chainId,
    logTransport: transport([announcementLog(), approvalLog()]),
    inspect: inspectLive, now, ...overrides
  } as never);
}

// --- the deployment or endpoint cannot serve discovery ----------------------

test("a deployment without an intent board says so and points at the manual path", async () => {
  const result = await run({ board: undefined });
  assert.deepEqual(result.requests, []);
  assert.match(result.unavailable!, /send you their request directly/iu);
});

test("an endpoint that cannot serve logs says so rather than reporting nothing found", async () => {
  const result = await run({ logTransport: undefined });
  assert.deepEqual(result.requests, []);
  assert.match(result.unavailable!, /paste a request or bearer link/iu);
});

test("a capability for another chain is never queried", async () => {
  let queried = false;
  const result = await run({
    capabilities: [capabilityFor(protectedAccount, "c2", 1)],
    logTransport: { async getBlockNumber() { queried = true; return 200n; }, async getLogs() { queried = true; return []; } }
  });
  assert.equal(queried, false, "an off-chain capability must not reach the endpoint");
  assert.deepEqual(result.requests, []);
});

// --- a stale or hostile RPC must fail closed --------------------------------

test("live state that no longer matches the announcement yields an unverified lead", async () => {
  const result = await run({ inspect: async () => ({ ...liveState, configVersion: 9n }) });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].trust, "detected");
  assert.equal(result.requests[0].request, undefined, "an unverified lead must not be reviewable");
});

test("an RPC that fails for one account does not hide the others", async () => {
  const second = capabilityFor(otherProtected, "c3");
  const result = await run({
    capabilities: [capability, second],
    inspect: async (account: string) =>
      (account.toLowerCase() === otherProtected.toLowerCase() ? Promise.reject(new Error("rpc down")) : liveState)
  });
  assert.equal(result.requests.length, 1, "the healthy account's request survives");
  assert.equal(result.requests[0].account.toLowerCase(), protectedAccount.toLowerCase());
  assert.ok(result.unavailable, "the partial failure is still reported");
});

test("a failure message never describes another party's account state", async () => {
  const result = await run({ inspect: async () => { throw new Error("guardianRoot 0xdeadbeef does not match"); } });
  assert.ok(result.unavailable);
  assert.ok(!result.unavailable!.includes("0xdeadbeef"), "the raw reason must not reach the screen");
});

// --- reorg ------------------------------------------------------------------

test("an approval that disappears in a reorg is reported as rolled back", async () => {
  const before = await run();
  assert.equal(before.requests[0].publishedApprovals, 1);

  const after = await run({
    logTransport: transport([announcementLog()]),
    previous: before.snapshots
  });
  assert.equal(after.requests[0].publishedApprovals, 0, "the count must fall with the chain");
  assert.equal(after.rolledBack.length, 1, "the disappearance must be announced, not silently absorbed");
  assert.equal(after.rolledBack[0], `0x${"77".repeat(32)}`);
});

test("an approval re-mined under a different block hash is still a rollback", async () => {
  const before = await run();
  const after = await run({
    logTransport: transport([announcementLog(), approvalLog({ blockHash: `0x${"99".repeat(32)}` })]),
    previous: before.snapshots
  });
  assert.equal(after.rolledBack.length, 1, "the entry the guardian was shown is gone even though an equal one returned");
});

test("a stable re-read reports no rollback", async () => {
  const before = await run();
  const after = await run({ previous: before.snapshots });
  assert.deepEqual(after.rolledBack, []);
  assert.equal(after.requests[0].publishedApprovals, 1);
});

test("the first read has nothing to compare against and reports no rollback", async () => {
  const result = await run({ previous: undefined });
  assert.deepEqual(result.rolledBack, []);
});

// --- two endpoints must agree before a request is called verified ------------

test("a request is verified only when both endpoints agree about live state", async () => {
  const agreeing = await run({ corroborate: inspectLive });
  assert.equal(agreeing.requests[0].trust, "verified");
  assert.ok(agreeing.requests[0].request, "an agreed request stays reviewable");
});

test("endpoints that disagree about the guardian root refuse to verify", async () => {
  const result = await run({
    corroborate: async () => ({ ...liveState, guardianRoot: `0x${"ff".repeat(32)}` })
  });
  assert.equal(result.requests[0].trust, "detected");
  assert.equal(result.requests[0].request, undefined, "a contested request must not be reviewable");
  assert.match(result.requests[0].issue!, /independent|disagree|confirm/iu);
});

test("endpoints that disagree about the configuration version refuse to verify", async () => {
  const result = await run({ corroborate: async () => ({ ...liveState, configVersion: 9n }) });
  assert.equal(result.requests[0].trust, "detected");
  assert.equal(result.requests[0].request, undefined);
});

test("endpoints that disagree about the validator set refuse to verify", async () => {
  const result = await run({
    corroborate: async () => ({ ...liveState, validators: ["0x9999999999999999999999999999999999999999"] })
  });
  assert.equal(result.requests[0].trust, "detected");
  assert.equal(result.requests[0].request, undefined);
});

test("a second endpoint that cannot be reached fails closed rather than trusting one", async () => {
  // Signing is the decision on the other side of this badge, so an unconfirmed
  // read is treated as unconfirmed rather than quietly accepted.
  const result = await run({ corroborate: async () => { throw new Error("verification rpc down"); } });
  assert.equal(result.requests[0].trust, "detected");
  assert.equal(result.requests[0].request, undefined);
});

test("without a second endpoint configured the single read still verifies", async () => {
  // Corroboration is an improvement where a second endpoint exists, not a new
  // hard requirement that would break a single-endpoint deployment.
  const result = await run({ corroborate: undefined });
  assert.equal(result.requests[0].trust, "verified");
});
