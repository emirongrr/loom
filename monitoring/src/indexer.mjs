// Manifest-driven chain indexer for the monitoring component.
//
// When a Loom deployment is produced, its manifest names the EntryPoint and the
// account factory. The indexer reads those straight from the manifest — so an
// operator connects a new deployment just by pointing at its manifest — then
// polls chain logs, decodes them with the canonical @loom/core ABIs, and feeds
// the dashboard metrics (accounts, operations, block facts, and TVL).
//
// Self-contained and read-only: it decodes events itself (no backend state
// machine) and takes an injected `rpc`, so the operator chooses which endpoint
// answers. Re-syncing an overlapping range never double-counts — each log is
// deduplicated by its block hash and log index.

import { decodeEventLog } from "viem";
import { EntryPointAbi, LoomAccountFactoryAbi } from "@loom/core";
import { computeTvlWei } from "./metrics.mjs";
import { instrumentRpc } from "./rpc.mjs";
import { ATTR, withSpan } from "./telemetry.mjs";

const USER_OPERATION_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const LOOM_ACCOUNT_CREATED = "0xbd904dc6e7931711be6993c6bab7de06fe4d57649c6006aadaa7e8003ce61467";

const lower = value => String(value).toLowerCase();

function resolveDeployment(manifest) {
  // Accept the canonical deployment manifest shape or a flat one.
  const entryPoint = manifest.entryPoint?.address ?? manifest.entryPoint;
  const factory = manifest.factory?.address ?? manifest.factory ?? manifest.accountFactory;
  if (!entryPoint || !factory) {
    throw new Error("manifest must name an EntryPoint and a factory");
  }
  const startBlock = Number(manifest.deployBlock ?? manifest.startBlock ?? 0);
  return { entryPoint: lower(entryPoint), factory: lower(factory), startBlock };
}

/**
 * @param {object} options
 * @param {(method: string, params: unknown[]) => Promise<any>} options.rpc
 * @param {object} options.manifest   deployment manifest (or { entryPoint, factory, startBlock })
 * @param {object} options.metrics    a dashboard-metrics instance from ./metrics.mjs
 * @param {string[]} [options.tokens] ERC-20 addresses to include in TVL
 */
export function createIndexer(options = {}) {
  const { entryPoint, factory, startBlock } = resolveDeployment(options.manifest);
  const metrics = options.metrics;
  const tokens = options.tokens ?? [];
  // Every RPC call is measured (requests, errors, duration) by provider.
  const rpc = instrumentRpc(options.rpc, { metrics, provider: options.provider ?? "primary" });
  const spanAttributes = { [ATTR.entryPoint]: entryPoint, ...(options.chainId ? { [ATTR.chainId]: options.chainId } : {}) };
  let cursor = startBlock;
  const seen = new Set(); // dedup key per log, for idempotent counting on re-sync

  function decode(log) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (lower(log.address) === entryPoint && topic0 === USER_OPERATION_EVENT) {
      const { args } = decodeEventLog({ abi: EntryPointAbi, topics: log.topics, data: log.data });
      return { kind: "userOperation", ...args };
    }
    if (lower(log.address) === factory && topic0 === LOOM_ACCOUNT_CREATED) {
      const { args } = decodeEventLog({ abi: LoomAccountFactoryAbi, topics: log.topics, data: log.data });
      return { kind: "accountCreated", account: args.account };
    }
    return null;
  }

  async function blockFacts(numbers) {
    const facts = new Map();
    for (const number of numbers) {
      const block = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
      if (block) facts.set(number, { gasLimit: BigInt(block.gasLimit), tsMs: Number(BigInt(block.timestamp)) * 1000 });
    }
    return facts;
  }

  const blockHashByNumber = new Map(); // number -> hash the ops were counted from
  const opsInBlock = new Map(); // `${number}:${hash}` -> userop count, for reorg accounting

  // Advance the index to the current head (or an explicit toBlock). Incremental
  // and idempotent — re-presented logs are skipped by their dedup key. Wrapped
  // in an `index-block-range` span with `process-log` / `process-user-operation`
  // / `detect-reorg` / `calculate-tvl` child spans. Returns the range processed.
  async function sync(toBlock) {
    const head = toBlock !== undefined ? Number(toBlock) : Number(BigInt(await rpc("eth_blockNumber", [])));
    if (head < cursor) return { from: cursor, to: cursor, operations: 0, accounts: 0 };

    return withSpan("index-block-range", { ...spanAttributes, "loom.from_block": cursor, "loom.to_block": head }, async () => {
      const fromHex = `0x${(cursor === 0 ? 0 : cursor).toString(16)}`;
      const toHex = `0x${head.toString(16)}`;
      const raw = await rpc("eth_getLogs", [{ address: [entryPoint, factory], fromBlock: fromHex, toBlock: toHex }]);

      const blockNumbers = [...new Set(raw.map(log => Number(BigInt(log.blockNumber))))];
      const facts = await blockFacts(blockNumbers);
      for (const [number, fact] of facts) metrics.recordBlock(number, fact);

      // Reorg accounting: a block number re-presented with a different hash
      // means its earlier operations were rolled back.
      await withSpan("detect-reorg", spanAttributes, () => {
        for (const number of blockNumbers) {
          const hash = lower(raw.find(log => Number(BigInt(log.blockNumber)) === number).blockHash);
          const known = blockHashByNumber.get(number);
          if (known && known !== hash) {
            metrics.recordReorg(opsInBlock.get(`${number}:${known}`) ?? 0);
          }
          blockHashByNumber.set(number, hash);
        }
      });

      let operations = 0;
      let accounts = 0;
      for (const log of raw) {
        const dedupKey = `${lower(log.blockHash)}:${log.logIndex ?? log.transactionIndex ?? ""}:${log.topics?.[1] ?? ""}`;
        if (seen.has(dedupKey)) continue;
        const parsed = await withSpan("process-log", { ...spanAttributes, "loom.block": Number(BigInt(log.blockNumber)) }, () => decode(log));
        if (!parsed) continue;
        seen.add(dedupKey);
        if (parsed.kind === "userOperation") {
          const number = Number(BigInt(log.blockNumber));
          await withSpan(
            "process-user-operation",
            { ...spanAttributes, [ATTR.operationType]: "user-operation", [ATTR.status]: parsed.success ? "success" : "failed" },
            () => {
              metrics.recordOperation({
                sender: parsed.sender,
                blockNumber: number,
                tsMs: facts.get(number)?.tsMs,
                gasCost: parsed.actualGasCost,
                gasUsed: parsed.actualGasUsed,
                success: parsed.success
              });
            }
          );
          opsInBlock.set(`${number}:${lower(log.blockHash)}`, (opsInBlock.get(`${number}:${lower(log.blockHash)}`) ?? 0) + 1);
          operations += 1;
        } else if (parsed.kind === "accountCreated") {
          metrics.recordAccount(parsed.account);
          accounts += 1;
        }
      }

      const tvl = await withSpan("calculate-tvl", spanAttributes, () => computeTvlWei(rpc, metrics.knownAccounts(), tokens));
      metrics.setTvlWei(tvl);
      metrics.setIndexerHead(head, Math.max(0, head - cursor));
      metrics.update();

      cursor = head;
      return { from: Number(fromHex), to: head, operations, accounts };
    });
  }

  return {
    entryPoint,
    factory,
    decode,
    sync,
    get cursor() {
      return cursor;
    }
  };
}
