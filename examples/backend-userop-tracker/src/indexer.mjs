// Manifest-driven chain indexer.
//
// When a Loom deployment is produced, its manifest names the EntryPoint and the
// account factory. The indexer reads those straight from the manifest — so an
// operator "connects" a new deployment just by pointing at its manifest — then
// polls chain logs, feeds the tracker, and updates the dashboard metrics
// (accounts, operations, block facts, and TVL). It is read-only and takes an
// injected `rpc`, so the operator chooses which endpoint answers.

import { computeTvlWei } from "./metrics.mjs";

function resolveDeployment(manifest) {
  // Accept the canonical deployment manifest shape or a flat one.
  const entryPoint = manifest.entryPoint?.address ?? manifest.entryPoint;
  const factory = manifest.factory?.address ?? manifest.factory ?? manifest.accountFactory;
  if (!entryPoint || !factory) {
    throw new Error("manifest must name an EntryPoint and a factory");
  }
  const startBlock = Number(manifest.deployBlock ?? manifest.startBlock ?? 0);
  return { entryPoint: entryPoint.toLowerCase(), factory: factory.toLowerCase(), startBlock };
}

/**
 * @param {object} options
 * @param {(method: string, params: unknown[]) => Promise<any>} options.rpc
 * @param {object} options.manifest   deployment manifest (or { entryPoint, factory, startBlock })
 * @param {object} options.tracker    a tracker from ./tracker.mjs
 * @param {object} options.metrics    a dashboard-metrics instance from ./metrics.mjs
 * @param {string[]} [options.tokens] ERC-20 addresses to include in TVL
 */
export function createIndexer(options = {}) {
  const rpc = options.rpc;
  const { entryPoint, factory, startBlock } = resolveDeployment(options.manifest);
  const tracker = options.tracker;
  const metrics = options.metrics;
  const tokens = options.tokens ?? [];
  let cursor = startBlock;

  async function blockFacts(numbers) {
    const facts = new Map();
    for (const number of numbers) {
      const block = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
      if (block) facts.set(number, { gasLimit: BigInt(block.gasLimit), tsMs: Number(BigInt(block.timestamp)) * 1000 });
    }
    return facts;
  }

  // Advance the index to the current head (or an explicit toBlock). Incremental
  // and idempotent — the tracker de-duplicates, and metrics accumulate from the
  // decoded operations. Returns the range processed.
  async function sync(toBlock) {
    const head = toBlock !== undefined ? Number(toBlock) : Number(BigInt(await rpc("eth_blockNumber", [])));
    if (head < cursor) return { from: cursor, to: cursor, operations: 0, accounts: 0 };

    const fromHex = `0x${(cursor === 0 ? 0 : cursor).toString(16)}`;
    const toHex = `0x${head.toString(16)}`;
    const raw = await rpc("eth_getLogs", [{ address: [entryPoint, factory], fromBlock: fromHex, toBlock: toHex }]);
    const logs = raw.map(log => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash
    }));

    await tracker.ingest({ logs, head });

    // Block facts for block-space accounting.
    const blockNumbers = [...new Set(logs.map(log => Number(BigInt(log.blockNumber))))];
    const facts = await blockFacts(blockNumbers);
    for (const [number, fact] of facts) metrics.recordBlock(number, fact);

    // Feed decoded operations and account creations to the dashboard metrics.
    let operations = 0;
    let accounts = 0;
    for (const log of logs) {
      const parsed = tracker.decodeLog(log);
      if (!parsed) continue;
      if (parsed.kind === "userOperation") {
        const number = Number(BigInt(log.blockNumber));
        metrics.recordOperation({
          sender: parsed.sender,
          blockNumber: number,
          tsMs: facts.get(number)?.tsMs,
          gasCost: parsed.actualGasCost,
          gasUsed: parsed.actualGasUsed,
          success: parsed.success
        });
        operations += 1;
      } else if (parsed.kind === "accountCreated") {
        metrics.recordAccount(parsed.account);
        accounts += 1;
      }
    }

    // Refresh TVL across the accounts seen so far.
    metrics.setTvlWei(await computeTvlWei(rpc, metrics.knownAccounts(), tokens));
    metrics.update();

    cursor = head;
    return { from: Number(fromHex), to: head, operations, accounts };
  }

  return {
    entryPoint,
    factory,
    sync,
    get cursor() {
      return cursor;
    }
  };
}
