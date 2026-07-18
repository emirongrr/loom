// Framework-neutral UserOperation tracker.
//
// A backend that observes Loom accounts is an *observer* — never the account
// signer or the source of truth for authority. This module is the reusable
// core of such a backend: it decodes EntryPoint and factory logs with the
// canonical @loom/core ABIs, tracks operations by (chainId, entryPoint,
// userOpHash) through idempotent state transitions, reconciles bundler receipts
// against chain logs under a finality policy, and survives reorgs, duplicate
// events, and dropped/replaced operations.
//
// It holds no keys, opens no sockets, and picks no framework: logs and head
// numbers are fed in, status changes and metrics come out through callbacks.
// The storage adapter is a four-method contract (get/put/list/delete), so an
// in-memory store and a PostgreSQL-backed one are interchangeable.

import { decodeEventLog } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";

const USER_OPERATION_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const LOOM_ACCOUNT_CREATED = "0xbd904dc6e7931711be6993c6bab7de06fe4d57649c6006aadaa7e8003ce61467";

const lower = value => String(value).toLowerCase();
const sha256Hex = value => value; // associations are hashed by the caller; see associate()

// --- storage --------------------------------------------------------------

// The minimal storage contract. A PostgreSQL adapter implements the same four
// methods over a table keyed by `key`; nothing else in the tracker changes.
export function createMemoryStore() {
  const rows = new Map();
  return {
    async get(key) {
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async put(key, value) {
      rows.set(key, structuredClone(value));
    },
    async list() {
      return [...rows.values()].map(value => structuredClone(value));
    },
    async delete(key) {
      rows.delete(key);
    }
  };
}

// --- tracker --------------------------------------------------------------

/**
 * @param {object} options
 * @param {number} options.chainId
 * @param {string} options.entryPoint
 * @param {string} [options.factory]
 * @param {object} [options.store]           storage adapter (defaults to memory)
 * @param {number} [options.confirmations]   blocks after inclusion before finality (default 12)
 * @param {(event: object) => void} [options.onEvent]   webhook-shaped status callback (idempotent)
 * @param {(metric: object) => void} [options.onMetric] OpenTelemetry-shaped metric callback
 */
export function createTracker(options = {}) {
  const chainId = options.chainId;
  const entryPoint = lower(options.entryPoint);
  const factory = options.factory ? lower(options.factory) : null;
  const store = options.store ?? createMemoryStore();
  const confirmations = options.confirmations ?? 12;
  const onEvent = options.onEvent ?? (() => {});
  const onMetric = options.onMetric ?? (() => {});

  // Emitted idempotency keys, so a webhook consumer never sees a transition
  // twice even if the same log is re-ingested after a provider hiccup.
  const emitted = new Set();
  // Block number -> block hash, to detect reorgs on re-ingest.
  const seenBlocks = new Map();
  // (sender:nonce) -> userOpHash, to spot replacement of a pending operation.
  const nonceOwners = new Map();
  // Hashed user id -> account. App-local, private, never placed in events.
  const associations = new Map();

  const key = userOpHash => `${chainId}:${entryPoint}:${lower(userOpHash)}`;
  const nonceKey = (sender, nonce) => `${lower(sender)}:${String(nonce)}`;

  function metric(name, value, labels = {}) {
    onMetric({ name, value, labels: Object.freeze({ chainId, ...labels }) });
  }

  function emit(type, record, blockHashForKey) {
    // Idempotency key binds the transition type to the block it concerns, so a
    // webhook consumer never sees the same transition twice — but a reorg that
    // invalidates a block and a later re-inclusion at a new block do re-emit,
    // because the type and block hash differ. The `type` component is what
    // keeps a reorg's rollback-to-submitted distinct from the original submit.
    const blockHash = blockHashForKey ?? record.block?.hash ?? "none";
    const idempotencyKey = `${record.key}:${type}:${blockHash}`;
    if (emitted.has(idempotencyKey)) return;
    emitted.add(idempotencyKey);
    onEvent(Object.freeze({ idempotencyKey, type, record: Object.freeze({ ...record }) }));
  }

  async function upsert(record) {
    await store.put(record.key, record);
    return record;
  }

  // Record an operation the backend submitted (or saw submitted) to a bundler,
  // before it appears on chain. Idempotent: re-submitting the same hash is a
  // no-op that returns the existing record.
  async function recordSubmitted(op) {
    const k = key(op.userOpHash);
    const existing = await store.get(k);
    if (existing) return existing;
    const record = {
      key: k,
      chainId,
      entryPoint,
      userOpHash: lower(op.userOpHash),
      sender: lower(op.sender),
      nonce: String(op.nonce),
      paymaster: op.paymaster ? lower(op.paymaster) : null,
      status: "submitted",
      block: null,
      success: null,
      actualGasCost: null,
      actualGasUsed: null,
      submittedAt: op.submittedAt ?? Date.now(),
      updatedAt: op.submittedAt ?? Date.now()
    };
    const owner = nonceKey(record.sender, record.nonce);
    // A different pending hash for the same (sender, nonce) is a replacement.
    const prior = nonceOwners.get(owner);
    if (prior && prior !== record.userOpHash) {
      const priorRecord = await store.get(key(prior));
      if (priorRecord && priorRecord.status === "submitted") {
        priorRecord.status = "replaced";
        priorRecord.updatedAt = record.submittedAt;
        await upsert(priorRecord);
        emit("userop.replaced", priorRecord);
        metric("userop.replaced", 1, { sender: record.sender });
      }
    }
    nonceOwners.set(owner, record.userOpHash);
    await upsert(record);
    emit("userop.submitted", record);
    metric("userop.submitted", 1, { sender: record.sender });
    return record;
  }

  // Decode one raw log ({ address, topics, data, blockNumber, blockHash }).
  // Returns the parsed shape or null if it is not a tracked event.
  function decodeLog(log) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (log.address && lower(log.address) === entryPoint && topic0 === USER_OPERATION_EVENT) {
      const { args } = decodeEventLog({ abi: EntryPointAbi, topics: log.topics, data: log.data });
      return { kind: "userOperation", ...args };
    }
    if (factory && log.address && lower(log.address) === factory && topic0 === LOOM_ACCOUNT_CREATED) {
      const { args } = decodeEventLog({ abi: LoomAccountFactoryAbi, topics: log.topics, data: log.data });
      return { kind: "accountCreated", account: args.account };
    }
    return null;
  }

  async function applyUserOperationLog(parsed, log) {
    const k = key(parsed.userOpHash);
    let record = await store.get(k);
    const block = { number: Number(log.blockNumber), hash: lower(log.blockHash) };
    if (!record) {
      // Seen on chain without a prior submit (another backend, or a restart):
      // adopt it as included directly.
      record = {
        key: k,
        chainId,
        entryPoint,
        userOpHash: lower(parsed.userOpHash),
        sender: lower(parsed.sender),
        nonce: String(parsed.nonce),
        paymaster: parsed.paymaster && !/^0x0+$/.test(parsed.paymaster) ? lower(parsed.paymaster) : null,
        status: "submitted",
        submittedAt: null,
        block: null,
        success: null,
        actualGasCost: null,
        actualGasUsed: null,
        updatedAt: Date.now()
      };
    }
    // Idempotent: the same inclusion at the same block is a no-op.
    if (record.status !== "submitted" && record.block?.hash === block.hash) return record;
    record.status = "included";
    record.block = block;
    record.success = parsed.success;
    record.actualGasCost = String(parsed.actualGasCost);
    record.actualGasUsed = String(parsed.actualGasUsed);
    record.updatedAt = Date.now();
    await upsert(record);
    emit("userop.included", record);
    metric("userop.included", 1, { sender: record.sender, success: String(parsed.success) });
    if (record.submittedAt) metric("userop.inclusion_latency_ms", record.updatedAt - record.submittedAt, { sender: record.sender });
    return record;
  }

  // Roll included/finalized records at or after `fromBlock` back to submitted,
  // because a reorg dropped the blocks they were observed in.
  async function rollbackFrom(fromBlock) {
    for (const record of await store.list()) {
      if (record.block && record.block.number >= fromBlock && record.status !== "submitted" && record.status !== "replaced") {
        const invalidatedHash = record.block.hash;
        record.status = "submitted";
        record.block = null;
        record.success = null;
        record.updatedAt = Date.now();
        await upsert(record);
        // Key the rollback to the block it invalidated, so each distinct reorg
        // notifies once.
        emit("userop.reorged", record, invalidatedHash);
        metric("userop.reorged", 1, { sender: record.sender });
      }
    }
    for (const [number] of seenBlocks) if (number >= fromBlock) seenBlocks.delete(number);
  }

  // Promote included records to finalized once head has advanced far enough.
  async function applyFinality(head) {
    for (const record of await store.list()) {
      if (record.status === "included" && record.block && head >= record.block.number + confirmations) {
        record.status = "finalized";
        record.updatedAt = Date.now();
        await upsert(record);
        emit("userop.finalized", record);
        metric("userop.finalized", 1, { sender: record.sender });
      }
    }
  }

  return {
    recordSubmitted,
    decodeLog,

    // Ingest a batch of raw logs plus the current head. Detects reorgs from
    // block-hash disagreement, applies inclusions, then finality. Safe to call
    // repeatedly with overlapping ranges — every step is idempotent.
    async ingest({ logs = [], blocks = [], head } = {}) {
      // Reorg detection: any known block whose hash changed invalidates it and
      // everything after.
      let reorgFrom = null;
      for (const b of blocks) {
        const number = Number(b.number);
        const hash = lower(b.hash);
        const known = seenBlocks.get(number);
        if (known && known !== hash) reorgFrom = reorgFrom === null ? number : Math.min(reorgFrom, number);
        seenBlocks.set(number, hash);
      }
      if (reorgFrom !== null) await rollbackFrom(reorgFrom);

      const created = [];
      for (const log of logs) {
        const parsed = decodeLog(log);
        if (!parsed) continue;
        seenBlocks.set(Number(log.blockNumber), lower(log.blockHash));
        if (parsed.kind === "userOperation") await applyUserOperationLog(parsed, log);
        else if (parsed.kind === "accountCreated") {
          created.push(lower(parsed.account));
          emit("account.created", { key: `account:${lower(parsed.account)}`, status: "created", account: lower(parsed.account), block: { number: Number(log.blockNumber), hash: lower(log.blockHash) } });
          metric("account.created", 1);
        }
      }
      if (head !== undefined) await applyFinality(Number(head));
      return { created };
    },

    // Reconcile a bundler-reported receipt against what the chain recorded.
    // Provider disagreement (bundler says success, chain says failure or the
    // operation is absent) is surfaced, not silently trusted.
    async reconcileReceipt(receipt) {
      const record = await store.get(key(receipt.userOpHash));
      if (!record || record.status === "submitted") {
        metric("provider.disagreement", 1, { reason: "chain-missing" });
        return { agreed: false, reason: "operation not found on chain", record: record ?? null };
      }
      if (typeof receipt.success === "boolean" && receipt.success !== record.success) {
        metric("provider.disagreement", 1, { reason: "success-mismatch" });
        return { agreed: false, reason: "bundler and chain disagree on success", record };
      }
      return { agreed: true, record };
    },

    // Mark an operation the bundler dropped without inclusion. Idempotent.
    async markDropped(userOpHash) {
      const record = await store.get(key(userOpHash));
      if (!record || record.status !== "submitted") return record ?? null;
      record.status = "dropped";
      record.updatedAt = Date.now();
      await upsert(record);
      emit("userop.dropped", record);
      metric("userop.dropped", 1, { sender: record.sender });
      return record;
    },

    async get(userOpHash) {
      return store.get(key(userOpHash));
    },

    // App-local user <-> account association. The user id is hashed by the
    // caller; the association is never exported in an emitted event.
    associate(hashedUserId, account) {
      associations.set(sha256Hex(hashedUserId), lower(account));
    },
    resolveAccount(hashedUserId) {
      return associations.get(sha256Hex(hashedUserId)) ?? null;
    }
  };
}

// --- sponsorship ----------------------------------------------------------

// Evaluate a sponsorship policy against a full UserOperation. Pure and
// credential-free: a sponsor backend decides whether to pay, it never signs
// the user's operation. The decision is bound to the operation and an expiry.
export function evaluateSponsorship(policy, userOp, now = Date.now()) {
  if (policy.expiry !== undefined && now > policy.expiry) {
    return { sponsored: false, reason: "policy expired" };
  }
  if (policy.allowedSenders && !policy.allowedSenders.map(lower).includes(lower(userOp.sender))) {
    return { sponsored: false, reason: "sender not allowlisted" };
  }
  const maxCost =
    BigInt(userOp.maxFeePerGas ?? 0n) *
    (BigInt(userOp.callGasLimit ?? 0n) + BigInt(userOp.verificationGasLimit ?? 0n) + BigInt(userOp.preVerificationGas ?? 0n));
  if (policy.maxCostWei !== undefined && maxCost > BigInt(policy.maxCostWei)) {
    return { sponsored: false, reason: "cost exceeds policy" };
  }
  return { sponsored: true, reason: "within policy", maxCost };
}
