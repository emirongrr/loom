import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";
import { RecoveryIntentBoardAbi } from "@loom/core/abi";
import {
  GuardianRecoveryError,
  assembleGuardianApprovals,
  createGuardianSet,
  createRecoveryIntentBoardReader,
  createRecoveryResponse,
  recoveryApprovalFromResponse,
  reconcileRecoveryDiscovery
} from "../dist/recovery.js";

const account = "0x1111111111111111111111111111111111111111";
const board = "0x6666666666666666666666666666666666666666";
const recoveryManager = "0x2222222222222222222222222222222222222222";
const otherManager = "0x8888888888888888888888888888888888888888";
const verifier = "0x3333333333333333333333333333333333333333";
const otherAccount = "0x7777777777777777777777777777777777777777";
const newValidator = "0x9999999999999999999999999999999999999999";
const recoveryId = `0x${"c1".repeat(32)}`;
const leafA = `0x${"1a".repeat(32)}`;
const leafB = `0x${"2b".repeat(32)}`;
const commitment = `0x${"dd".repeat(32)}`;
const salt = `0x${"ef".repeat(32)}`;
const hash32 = `0x${"77".repeat(32)}`;

const APPROVAL_DATA = parseAbiParameters(
  "address recoveryManager, address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof"
);
const ANNOUNCE_DATA = parseAbiParameters(
  "address recoveryManager, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce, uint48 expiresAt"
);

function approvalLog(overrides = {}) {
  const o = {
    account, recoveryId, guardianLeaf: leafA, recoveryManager, verifier,
    signature: `0x${"ee".repeat(65)}`, proof: [leafB],
    blockNumber: 100n, blockHash: `0x${"b1".repeat(32)}`, logIndex: 0,
    address: board, removed: false, ...overrides
  };
  return {
    address: o.address,
    topics: encodeEventTopics({
      abi: RecoveryIntentBoardAbi,
      eventName: "RecoveryApprovalPublished",
      args: { account: o.account, recoveryId: o.recoveryId, guardianLeaf: o.guardianLeaf }
    }),
    data: encodeAbiParameters(APPROVAL_DATA, [o.recoveryManager, o.verifier, commitment, salt, o.signature, o.proof]),
    blockNumber: o.blockNumber,
    blockHash: o.blockHash,
    logIndex: o.logIndex,
    transactionHash: `0x${"aa".repeat(32)}`,
    removed: o.removed
  };
}

function announcementLog(overrides = {}) {
  const o = {
    account, recoveryId, recoveryManager, blockNumber: 90n,
    blockHash: `0x${"b0".repeat(32)}`, logIndex: 0, address: board, removed: false, ...overrides
  };
  return {
    address: o.address,
    topics: encodeEventTopics({
      abi: RecoveryIntentBoardAbi,
      eventName: "RecoveryAnnounced",
      args: { account: o.account, recoveryId: o.recoveryId }
    }),
    data: encodeAbiParameters(ANNOUNCE_DATA, [o.recoveryManager, hash32, newValidator, hash32, hash32, 2, 4n, 0n, 1900000000n]),
    blockNumber: o.blockNumber,
    blockHash: o.blockHash,
    logIndex: o.logIndex,
    transactionHash: `0x${"ab".repeat(32)}`,
    removed: o.removed
  };
}

function transport(logs, { latest = 200n, onQuery } = {}) {
  return {
    async getBlockNumber() { return latest; },
    async getLogs(query) {
      onQuery?.(query);
      return logs.filter(log => log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock);
    }
  };
}

function reader(logTransport, options = {}) {
  return createRecoveryIntentBoardReader({
    chainId: 11155111, account, board, recoveryManager, logTransport, ...options
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof GuardianRecoveryError, `expected GuardianRecoveryError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("an approval log decodes into the exact tuple the manager will accept", async () => {
  const snapshot = await reader(transport([approvalLog()])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 1);
  const found = snapshot.approvals[0];
  assert.equal(found.status, "unverified");
  assert.equal(found.recoveryId, recoveryId);
  assert.equal(found.guardianLeaf, leafA);
  assert.deepEqual(found.approval, {
    verifier,
    keyCommitment: commitment,
    salt,
    signature: `0x${"ee".repeat(65)}`,
    proof: [leafB],
    leaf: leafA
  });
});

test("discovery never reports an approval as verified", async () => {
  const snapshot = await reader(transport([approvalLog(), announcementLog()])).discover({ fromBlock: 0n });
  for (const entry of [...snapshot.approvals, ...snapshot.announcements]) {
    assert.equal(entry.status, "unverified");
  }
});

test("block range is split into bounded windows and the transport is never asked for more", async () => {
  const queries = [];
  const source = transport([], { latest: 25_000n, onQuery: query => queries.push(query) });
  await createRecoveryIntentBoardReader({
    chainId: 11155111, account, board, recoveryManager, logTransport: source, maxBlockRange: 10_000n
  }).discover({ fromBlock: 0n, toBlock: 25_000n });

  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.ok(query.toBlock - query.fromBlock < 10_000n, "a window exceeded maxBlockRange");
    assert.equal(query.address, board);
  }
  assert.equal(queries[0].fromBlock, 0n);
  assert.equal(queries.at(-1).toBlock, 25_000n);
});

test("queries are filtered server-side by event and account so a busy board cannot starve discovery", async () => {
  const queries = [];
  await reader(transport([], { onQuery: query => queries.push(query) })).discover({ fromBlock: 0n, toBlock: 100n });

  assert.equal(queries.length, 1);
  const [events, accountTopic] = queries[0].topics;
  assert.equal(events.length, 2, "both board events must be requested");
  assert.deepEqual(
    [...events].sort(),
    [
      encodeEventTopics({ abi: RecoveryIntentBoardAbi, eventName: "RecoveryAnnounced" })[0],
      encodeEventTopics({ abi: RecoveryIntentBoardAbi, eventName: "RecoveryApprovalPublished" })[0]
    ].sort()
  );
  assert.equal(
    accountTopic,
    encodeEventTopics({ abi: RecoveryIntentBoardAbi, eventName: "RecoveryApprovalPublished", args: { account } })[1],
    "the indexed account must be filtered at the endpoint, not only locally"
  );
});

test("a range needing more windows than allowed fails closed instead of hammering the RPC", async () => {
  await expectCode(
    createRecoveryIntentBoardReader({
      chainId: 11155111, account, board, recoveryManager,
      logTransport: transport([], { latest: 10_000_000n }), maxBlockRange: 1_000n, maxWindows: 4
    }).discover({ fromBlock: 0n, toBlock: 10_000_000n }),
    "RECOVERY_DISCOVERY_LIMIT_EXCEEDED"
  );
});

test("more logs than the cap fails closed rather than growing unbounded", async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    approvalLog({ guardianLeaf: `0x${index.toString(16).padStart(2, "0").repeat(32)}`, logIndex: index })
  );
  await expectCode(reader(transport(many), { maxLogs: 8 }).discover({ fromBlock: 0n }), "RECOVERY_DISCOVERY_LIMIT_EXCEEDED");
});

test("a transport that fails is reported as unavailable, not as an empty result", async () => {
  const failing = {
    async getBlockNumber() { return 200n; },
    async getLogs() { throw new Error("rpc: query returned more than 10000 results"); }
  };
  await expectCode(reader(failing).discover({ fromBlock: 0n }), "RECOVERY_DISCOVERY_UNAVAILABLE");
});

test("logs from a contract other than the board are discarded", async () => {
  const snapshot = await reader(transport([approvalLog({ address: otherAccount })])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 0);
});

test("logs for another account or another recovery manager are discarded", async () => {
  const snapshot = await reader(transport([
    approvalLog({ account: otherAccount, guardianLeaf: leafA }),
    approvalLog({ recoveryManager: otherManager, guardianLeaf: leafB, logIndex: 1 })
  ])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 0);
});

test("a duplicate guardian leaf keeps only the earliest publication", async () => {
  const snapshot = await reader(transport([
    approvalLog({ blockNumber: 120n, signature: `0x${"cc".repeat(65)}` }),
    approvalLog({ blockNumber: 100n, signature: `0x${"ee".repeat(65)}` })
  ])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 1);
  assert.equal(snapshot.approvals[0].blockNumber, 100n);
  assert.equal(snapshot.approvals[0].approval.signature, `0x${"ee".repeat(65)}`);
});

test("a signature or proof beyond the contract's own bounds is discarded", async () => {
  const snapshot = await reader(transport([
    approvalLog({ guardianLeaf: leafA, signature: `0x${"ee".repeat(4097)}` }),
    approvalLog({ guardianLeaf: leafB, proof: Array.from({ length: 33 }, () => hash32), logIndex: 1 })
  ])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 0);
});

test("a removed log is never counted as an approval", async () => {
  const snapshot = await reader(transport([approvalLog({ removed: true })])).discover({ fromBlock: 0n });
  assert.equal(snapshot.approvals.length, 0);
});

test("approvals shallower than the confirmation depth are reported unconfirmed", async () => {
  const snapshot = await reader(
    transport([approvalLog({ guardianLeaf: leafA, blockNumber: 100n }), approvalLog({ guardianLeaf: leafB, blockNumber: 199n, logIndex: 1 })], { latest: 200n }),
    { confirmations: 5n }
  ).discover({ fromBlock: 0n });
  const byLeaf = Object.fromEntries(snapshot.approvals.map(entry => [entry.guardianLeaf, entry]));
  assert.equal(byLeaf[leafA].confirmed, true);
  assert.equal(byLeaf[leafB].confirmed, false);
  assert.equal(snapshot.confirmedApprovalCount, 1);
});

test("an announcement decodes its full identity and stays unverified", async () => {
  const snapshot = await reader(transport([announcementLog()])).discover({ fromBlock: 0n });
  assert.equal(snapshot.announcements.length, 1);
  const found = snapshot.announcements[0];
  assert.equal(found.recoveryId, recoveryId);
  assert.equal(found.newValidator, newValidator);
  assert.equal(found.newGuardianThreshold, 2);
  assert.equal(found.configVersion, 4n);
  assert.equal(found.status, "unverified");
});

test("a reorg that drops an approval rolls the count back and names what was lost", async () => {
  const before = await reader(transport([
    approvalLog({ guardianLeaf: leafA, blockNumber: 100n }),
    approvalLog({ guardianLeaf: leafB, blockNumber: 110n, blockHash: `0x${"b2".repeat(32)}`, logIndex: 1 })
  ])).discover({ fromBlock: 0n });
  assert.equal(before.approvals.length, 2);

  const after = await reader(transport([approvalLog({ guardianLeaf: leafA, blockNumber: 100n })])).discover({ fromBlock: 0n });
  const reconciled = reconcileRecoveryDiscovery(before, after);
  assert.equal(reconciled.rolledBack, true);
  assert.deepEqual(reconciled.droppedApprovals, [leafB]);
  assert.equal(reconciled.snapshot.approvals.length, 1);
});

test("an approval re-mined under a different block hash counts as rolled back", async () => {
  const before = await reader(transport([approvalLog({ blockHash: `0x${"b1".repeat(32)}` })])).discover({ fromBlock: 0n });
  const after = await reader(transport([approvalLog({ blockHash: `0x${"99".repeat(32)}` })])).discover({ fromBlock: 0n });
  const reconciled = reconcileRecoveryDiscovery(before, after);
  assert.equal(reconciled.rolledBack, true);
  assert.deepEqual(reconciled.droppedApprovals, [leafA]);
});

test("a stable re-query is not reported as a rollback", async () => {
  const logs = [approvalLog()];
  const before = await reader(transport(logs)).discover({ fromBlock: 0n });
  const after = await reader(transport(logs)).discover({ fromBlock: 0n });
  const reconciled = reconcileRecoveryDiscovery(before, after);
  assert.equal(reconciled.rolledBack, false);
  assert.deepEqual(reconciled.droppedApprovals, []);
  assert.equal(reconciled.snapshot.approvals.length, 1);
});

test("reconciling snapshots for different accounts fails closed", async () => {
  const before = await reader(transport([approvalLog()])).discover({ fromBlock: 0n });
  const after = await createRecoveryIntentBoardReader({
    chainId: 11155111, account: otherAccount, board, recoveryManager, logTransport: transport([])
  }).discover({ fromBlock: 0n });
  assert.throws(() => reconcileRecoveryDiscovery(before, after), error => {
    assert.ok(error instanceof GuardianRecoveryError);
    assert.equal(error.code, "INVALID_RECOVERY_APPROVAL_LOG");
    return true;
  });
});

test("an on-chain approval and an off-chain response for the same guardian are byte-identical", async () => {
  const signature = `0x${"ee".repeat(65)}`;
  const onChain = (await reader(transport([approvalLog({ signature })])).discover({ fromBlock: 0n })).approvals[0];

  const offChain = recoveryApprovalFromResponse(createRecoveryResponse({
    requestId: recoveryId,
    chainId: 11155111,
    account,
    recoveryDigest: hash32,
    guardianLeaf: leafA,
    verifier,
    keyCommitment: commitment,
    salt,
    proof: [leafB],
    signature,
    signedAt: 1_800_000_000,
    expiresAt: 1_900_000_000
  }));

  // The whole "approve on-chain or share privately" choice rests on this: the
  // guardian's privacy decision must not change the artefact it produces.
  assert.deepEqual(onChain.approval, offChain);
});

test("a bundle mixing one published and one imported approval assembles and sorts deterministically", async () => {
  const guardians = [
    { kind: "ecdsa", verifier, verifierCodeHash: hash32, address: "0x000000000000000000000000000000000000aaa1", salt },
    { kind: "ecdsa", verifier, verifierCodeHash: hash32, address: "0x000000000000000000000000000000000000bbb2", salt: `0x${"cd".repeat(32)}` }
  ];
  const set = createGuardianSet({ guardians, threshold: 2 });
  const [first, second] = set.guardians;

  const published = { leaf: first.leaf, signature: `0x${"11".repeat(65)}` };
  const imported = { leaf: second.leaf, signature: `0x${"22".repeat(65)}` };

  // Feed them in reverse order; assembly must not depend on arrival order.
  const bundle = await assembleGuardianApprovals({ set, approvals: [imported, published], threshold: 2 });
  assert.equal(bundle.ready, true);
  assert.equal(bundle.approvals.length, 2);
  const leaves = bundle.approvals.map(entry => entry.leaf);
  assert.deepEqual([...leaves].sort(), leaves, "approvals must be sorted by leaf for the manager");
});

test("a reader without a log transport fails closed instead of silently finding nothing", () => {
  assert.throws(
    () => createRecoveryIntentBoardReader({ chainId: 11155111, account, board, recoveryManager }),
    error => {
      assert.ok(error instanceof GuardianRecoveryError);
      assert.equal(error.code, "RECOVERY_DISCOVERY_UNAVAILABLE");
      return true;
    }
  );
});
