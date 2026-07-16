import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertBundlerUrl, smokeBundler } from "./bundler-smoke.mjs";
import { validateBundlerQualification } from "./validate-bundler-qualification.mjs";

export async function buildBundlerQualificationEvidence({
  config,
  fetch: fetchImpl = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  receiptAttempts = 60,
  receiptPollIntervalMs = 1_000
}) {
  assertObject(config, "config");
  for (const key of [
    "version",
    "network",
    "nodeUrl",
    "entryPoint",
    "bundlers",
    "lifecycle",
    "lifecycleVectors",
    "rejectionVectors",
    "checks",
    "receipts"
  ]) {
    if (!(key in config)) throw new Error(`missing qualification config field: ${key}`);
  }
  if (config.version !== 2) throw new Error("unsupported bundler qualification config version");
  assertObject(config.network, "network");
  if (!Number.isSafeInteger(config.network.chainId) || config.network.chainId <= 0) {
    throw new Error("network.chainId must be positive");
  }
  if (!config.network.name || typeof config.network.name !== "string") {
    throw new Error("network.name is required");
  }
  assertAddress(config.entryPoint, "entryPoint");
  if (!Array.isArray(config.bundlers) || config.bundlers.length < 2) {
    throw new Error("qualification config requires at least two bundlers");
  }
  if (!Number.isSafeInteger(receiptAttempts) || receiptAttempts <= 0) {
    throw new Error("receiptAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(receiptPollIntervalMs) || receiptPollIntervalMs < 0) {
    throw new Error("receiptPollIntervalMs must be a non-negative integer");
  }

  assertBundlerUrl(config.nodeUrl);
  const nodeChain = await rpc(config.nodeUrl, "eth_chainId", [], fetchImpl);
  if (nodeChain.error || parseRpcChainId(nodeChain.result) !== config.network.chainId) {
    throw new Error("nodeUrl chainId must match network.chainId");
  }

  const bundlers = [];
  const bundlerUrls = new Map();
  for (const [index, bundler] of config.bundlers.entries()) {
    const label = `bundlers[${index}]`;
    assertObject(bundler, label);
    for (const key of ["name", "implementation", "operator", "endpointKind", "url", "specTests"]) {
      if (!(key in bundler)) throw new Error(`missing ${label}.${key}`);
    }

    const smoke = await smokeBundler({
      bundlerUrl: bundler.url,
      expectedEntryPoint: config.entryPoint,
      expectedChainId: config.network.chainId,
      fetch: fetchImpl
    });

    bundlers.push(Object.freeze({
      name: requireString(bundler.name, `${label}.name`),
      implementation: requireString(bundler.implementation, `${label}.implementation`),
      operator: requireString(bundler.operator, `${label}.operator`),
      rpcOrigin: smoke.rpcOrigin,
      endpointKind: requireString(bundler.endpointKind, `${label}.endpointKind`),
      chainId: smoke.chainId,
      supportedEntryPoints: smoke.supportedEntryPoints,
      specTests: cloneJson(bundler.specTests)
    }));
    bundlerUrls.set(bundler.name.toLowerCase(), bundler.url);
  }

  const executions = await collectLifecycleExecutions({
    lifecycleVectors: config.lifecycleVectors,
    lifecycle: config.lifecycle,
    bundlerUrls,
    nodeUrl: config.nodeUrl,
    entryPoint: config.entryPoint,
    fetchImpl,
    sleep,
    receiptAttempts,
    receiptPollIntervalMs
  });
  const rejections = await collectRejections(config.rejectionVectors, bundlerUrls, config.entryPoint, fetchImpl);
  const lifecycle = normalizeLifecycle(
    config.lifecycle,
    config.network.chainId,
    config.entryPoint,
    executions,
    rejections
  );

  const evidence = Object.freeze({
    version: 2,
    network: cloneJson(config.network),
    entryPoint: config.entryPoint,
    bundlers: Object.freeze(bundlers),
    lifecycle,
    checks: normalizeLiveChecks(config.checks),
    receipts: normalizeAggregateReceipts(config.receipts, lifecycle[0].receipts),
    generatedAt: new Date().toISOString(),
    generator: "tools/evidence/run-bundler-qualification.mjs"
  });

  validateBundlerQualification(evidence);
  return evidence;
}

const REJECTION_KEYS = [
  "paymasterRejected",
  "invalidSignatureRejected",
  "staleNonceRejected",
  "malformedCalldataRejected",
  "unsupportedModeRejected"
];
const LIFECYCLE_OPERATION_KEYS = [
  "deploy",
  "single",
  "batch",
  "nativeGas",
  "paymasterApproved",
  "sessionGrant",
  "sessionRevoke",
  "recoveryProposal",
  "recoveryCancel",
  "migrationSchedule",
  "migrationCancel",
  "vaultSchedule",
  "vaultCancel"
];
const USER_OPERATION_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const LIVE_CHECK_KEYS = [
  "counterfactualDeploy",
  "singleUserOperation",
  "atomicBatchUserOperation",
  "nativeGas",
  "paymasterApproved",
  ...REJECTION_KEYS,
  "receiptReconciliation"
];
const STAGE_KEYS = ["session", "recovery", "migration", "vault"];

async function collectLifecycleExecutions({
  lifecycleVectors,
  lifecycle,
  bundlerUrls,
  nodeUrl,
  entryPoint,
  fetchImpl,
  sleep,
  receiptAttempts,
  receiptPollIntervalMs
}) {
  if (!Array.isArray(lifecycleVectors) || lifecycleVectors.length !== bundlerUrls.size) {
    throw new Error("lifecycleVectors must include one result per bundler");
  }
  if (!Array.isArray(lifecycle) || lifecycle.length !== bundlerUrls.size) {
    throw new Error("lifecycle must include one result per bundler");
  }

  const accounts = new Map();
  for (const [index, item] of lifecycle.entries()) {
    const label = `lifecycle[${index}]`;
    assertObject(item, label);
    const bundler = requireString(item.bundler, `${label}.bundler`).toLowerCase();
    if (!bundlerUrls.has(bundler)) throw new Error(`${label}.bundler must match a configured bundler`);
    if (accounts.has(bundler)) throw new Error("lifecycle contains duplicate bundler results");
    assertAddress(item.account, `${label}.account`);
    accounts.set(bundler, item.account);
  }

  const results = new Map();
  const seenUserOperationHashes = new Set();
  for (const [index, item] of lifecycleVectors.entries()) {
    const label = `lifecycleVectors[${index}]`;
    assertObject(item, label);
    const bundler = requireString(item.bundler, `${label}.bundler`).toLowerCase();
    const url = bundlerUrls.get(bundler);
    if (!url) throw new Error(`${label}.bundler must match a configured bundler`);
    if (results.has(bundler)) throw new Error("lifecycleVectors contains duplicate bundler results");
    assertObject(item.operations, `${label}.operations`);

    const account = accounts.get(bundler);
    const evidence = {};
    for (const key of LIFECYCLE_OPERATION_KEYS) {
      const operationLabel = `${label}.operations.${key}`;
      const vector = item.operations[key];
      assertObject(vector, operationLabel);
      assertObject(vector.userOperation, `${operationLabel}.userOperation`);
      if (!Array.isArray(vector.postState) || vector.postState.length === 0) {
        throw new Error(`${operationLabel}.postState must include at least one exact state check`);
      }

      const submission = await rpc(url, "eth_sendUserOperation", [vector.userOperation, entryPoint], fetchImpl);
      if (submission.error) throw new Error(`${operationLabel} submission was rejected`);
      assertBytes32(submission.result, `${operationLabel} submitted userOperationHash`);
      const userOperationHash = submission.result.toLowerCase();
      if (seenUserOperationHashes.has(userOperationHash)) {
        throw new Error(`${operationLabel} returned a duplicate userOperationHash`);
      }
      seenUserOperationHashes.add(userOperationHash);

      const receipt = await waitForUserOperationReceipt({
        url,
        userOperationHash,
        fetchImpl,
        sleep,
        receiptAttempts,
        receiptPollIntervalMs,
        label: operationLabel
      });
      const receiptEvidence = await reconcileReceipt({
        receipt,
        userOperationHash,
        account,
        nodeUrl,
        entryPoint,
        fetchImpl,
        label: operationLabel
      });
      await verifyPostState({
        checks: vector.postState,
        nodeUrl,
        blockNumber: receiptEvidence.blockNumber,
        fetchImpl,
        label: operationLabel
      });

      evidence[key] = Object.freeze({
        userOperationHash,
        transactionHash: receiptEvidence.transactionHash,
        blockHash: receiptEvidence.blockHash,
        blockNumber: receiptEvidence.blockNumber,
        stateChecks: vector.postState.length,
        eventReconciled: true,
        receiptReconciled: true
      });
    }
    results.set(bundler, Object.freeze(evidence));
  }
  return results;
}

async function waitForUserOperationReceipt({
  url,
  userOperationHash,
  fetchImpl,
  sleep,
  receiptAttempts,
  receiptPollIntervalMs,
  label
}) {
  for (let attempt = 0; attempt < receiptAttempts; attempt += 1) {
    const response = await rpc(url, "eth_getUserOperationReceipt", [userOperationHash], fetchImpl);
    if (response.error) throw new Error(`${label} receipt lookup failed`);
    if (response.result !== null) return response.result;
    if (attempt + 1 < receiptAttempts) await sleep(receiptPollIntervalMs);
  }
  throw new Error(`${label} receipt was not available before timeout`);
}

async function reconcileReceipt({ receipt, userOperationHash, account, nodeUrl, entryPoint, fetchImpl, label }) {
  assertObject(receipt, `${label} receipt`);
  assertBytes32(receipt.userOpHash, `${label} receipt.userOpHash`);
  if (receipt.userOpHash.toLowerCase() !== userOperationHash) {
    throw new Error(`${label} receipt userOperationHash does not match submission`);
  }
  assertAddress(receipt.sender, `${label} receipt.sender`);
  if (receipt.sender.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`${label} receipt sender does not match lifecycle account`);
  }
  if (receipt.success !== true) throw new Error(`${label} did not succeed`);
  assertObject(receipt.receipt, `${label} transaction receipt`);
  const transactionHash = receipt.receipt.transactionHash;
  const blockHash = receipt.receipt.blockHash;
  const blockNumber = receipt.receipt.blockNumber;
  assertBytes32(transactionHash, `${label} transactionHash`);
  assertBytes32(blockHash, `${label} blockHash`);
  assertRpcQuantity(blockNumber, `${label} blockNumber`);
  if (receipt.receipt.status !== "0x1") throw new Error(`${label} transaction receipt status must be 0x1`);

  const chainResponse = await rpc(nodeUrl, "eth_getTransactionReceipt", [transactionHash], fetchImpl);
  if (chainResponse.error || chainResponse.result === null) throw new Error(`${label} chain receipt is missing`);
  const chainReceipt = chainResponse.result;
  assertObject(chainReceipt, `${label} chain receipt`);
  if (
    String(chainReceipt.transactionHash).toLowerCase() !== transactionHash.toLowerCase()
    || String(chainReceipt.blockHash).toLowerCase() !== blockHash.toLowerCase()
    || chainReceipt.blockNumber !== blockNumber
    || chainReceipt.status !== "0x1"
  ) {
    throw new Error(`${label} chain receipt does not match bundler receipt`);
  }
  if (!Array.isArray(chainReceipt.logs)) throw new Error(`${label} chain receipt logs are required`);
  const hasUserOperationEvent = chainReceipt.logs.some(log => (
    log
    && typeof log === "object"
    && String(log.address).toLowerCase() === entryPoint.toLowerCase()
    && Array.isArray(log.topics)
    && String(log.topics[0]).toLowerCase() === USER_OPERATION_EVENT_TOPIC
    && String(log.topics[1]).toLowerCase() === userOperationHash
  ));
  if (!hasUserOperationEvent) throw new Error(`${label} UserOperationEvent was not reconciled`);
  return { transactionHash, blockHash, blockNumber };
}

async function verifyPostState({ checks, nodeUrl, blockNumber, fetchImpl, label }) {
  for (const [index, check] of checks.entries()) {
    const checkLabel = `${label}.postState[${index}]`;
    assertObject(check, checkLabel);
    assertAddress(check.to, `${checkLabel}.to`);
    assertHex(check.data, `${checkLabel}.data`);
    assertHex(check.expectedResult, `${checkLabel}.expectedResult`);
    const response = await rpc(nodeUrl, "eth_call", [{ to: check.to, data: check.data }, blockNumber], fetchImpl);
    if (response.error) throw new Error(`${checkLabel} call failed`);
    assertHex(response.result, `${checkLabel} result`);
    if (response.result.toLowerCase() !== check.expectedResult.toLowerCase()) {
      throw new Error(`${checkLabel} post-state mismatch`);
    }
  }
}

async function collectRejections(rejectionVectors, bundlerUrls, entryPoint, fetchImpl) {
  if (!Array.isArray(rejectionVectors) || rejectionVectors.length !== bundlerUrls.size) {
    throw new Error("rejectionVectors must include one result per bundler");
  }
  const results = new Map();
  for (const [index, item] of rejectionVectors.entries()) {
    const label = `rejectionVectors[${index}]`;
    assertObject(item, label);
    const bundler = requireString(item.bundler, `${label}.bundler`).toLowerCase();
    const url = bundlerUrls.get(bundler);
    if (!url) throw new Error(`${label}.bundler must match a configured bundler`);
    if (results.has(bundler)) throw new Error("rejectionVectors contains duplicate bundler results");
    assertObject(item.vectors, `${label}.vectors`);

    const evidence = {};
    for (const key of REJECTION_KEYS) {
      const vector = item.vectors[key];
      assertObject(vector, `${label}.vectors.${key}`);
      assertObject(vector.userOperation, `${label}.vectors.${key}.userOperation`);
      assertBytes32(vector.userOperationHash, `${label}.vectors.${key}.userOperationHash`);

      const submission = await rpc(url, "eth_sendUserOperation", [vector.userOperation, entryPoint], fetchImpl);
      if (!submission.error) throw new Error(`${label}.vectors.${key} was unexpectedly accepted`);
      if (!Number.isSafeInteger(submission.error.code) || submission.error.code >= 0) {
        throw new Error(`${label}.vectors.${key} rejection must include a negative integer RPC code`);
      }
      const receipt = await rpc(url, "eth_getUserOperationReceipt", [vector.userOperationHash], fetchImpl);
      if (receipt.error) throw new Error(`${label}.vectors.${key} receipt lookup failed`);
      if (receipt.result !== null) throw new Error(`${label}.vectors.${key} unexpectedly has a receipt`);
      evidence[key] = Object.freeze({
        rpcCode: submission.error.code,
        userOperationHash: vector.userOperationHash,
        receiptAbsent: true
      });
    }
    results.set(bundler, Object.freeze(evidence));
  }
  return results;
}

async function rpc(url, method, params, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!("result" in payload) && !("error" in payload)) throw new Error(`${method} returned malformed JSON-RPC`);
  return payload;
}

function normalizeLifecycle(lifecycle, chainId, entryPoint, executions, rejections) {
  if (!Array.isArray(lifecycle)) throw new Error("lifecycle must be an array");
  return Object.freeze(lifecycle.map((item, index) => {
    const label = `lifecycle[${index}]`;
    assertObject(item, label);
    const bundler = String(item.bundler).toLowerCase();
    const liveExecutions = executions.get(bundler);
    const receipts = Object.fromEntries(
      LIFECYCLE_OPERATION_KEYS.map(key => [key, liveExecutions?.[key]?.transactionHash])
    );
    return Object.freeze({
      ...cloneJson(item),
      chainId,
      entryPoint,
      checks: normalizeLiveChecks(item.checks),
      stages: normalizeLiveStages(item.stages),
      receipts: Object.freeze(receipts),
      executions: liveExecutions,
      rejections: rejections.get(bundler)
    });
  }));
}

function normalizeLiveChecks(configuredChecks) {
  assertObject(configuredChecks, "checks");
  const checks = cloneJson(configuredChecks);
  for (const key of LIVE_CHECK_KEYS) checks[key] = true;
  return Object.freeze(checks);
}

function normalizeLiveStages(configuredStages) {
  assertObject(configuredStages, "stages");
  return Object.freeze(Object.fromEntries(STAGE_KEYS.map(key => {
    assertObject(configuredStages[key], `stages.${key}`);
    return [key, Object.freeze({
      ...cloneJson(configuredStages[key]),
      scheduled: true,
      cancelled: true,
      receiptReconciled: true
    })];
  })));
}

function normalizeAggregateReceipts(configuredReceipts, liveReceipts) {
  assertObject(configuredReceipts, "receipts");
  return Object.freeze({
    deploy: liveReceipts.deploy,
    single: liveReceipts.single,
    batch: liveReceipts.batch,
    nativeGas: liveReceipts.nativeGas,
    paymasterApproved: liveReceipts.paymasterApproved,
    directHandleOpsFallback: configuredReceipts.directHandleOpsFallback
  });
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}

function assertHex(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be 0x-prefixed whole bytes`);
  }
}

function assertRpcQuantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} must be an RPC quantity`);
  }
}

function parseRpcChainId(value) {
  assertRpcQuantity(value, "nodeUrl chainId");
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("nodeUrl chainId must be positive");
  return parsed;
}

function requireString(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath) {
    throw new Error("usage: node tools/evidence/run-bundler-qualification.mjs <config.json> [output.json]");
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const evidence = await buildBundlerQualificationEvidence({ config });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, text);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
