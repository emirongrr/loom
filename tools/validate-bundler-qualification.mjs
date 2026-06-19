import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_CHECKS = [
  "counterfactualDeploy",
  "singleUserOperation",
  "atomicBatchUserOperation",
  "nativeGas",
  "paymasterApproved",
  "paymasterRejected",
  "invalidSignatureRejected",
  "staleNonceRejected",
  "malformedCalldataRejected",
  "unsupportedModeRejected",
  "receiptReconciliation",
  "permissionlessHandleOpsFallback"
];

const PERMISSIONLESS_ENDPOINT_KINDS = new Set(["local", "permissionless", "self-hosted"]);

export function validateBundlerQualification(evidence) {
  assertObject(evidence, "evidence");
  for (const key of ["version", "network", "entryPoint", "bundlers", "checks", "receipts"]) {
    if (!(key in evidence)) throw new Error(`missing top-level evidence field: ${key}`);
  }
  if (evidence.version !== 1) throw new Error("unsupported bundler qualification evidence version");

  assertNetwork(evidence.network);
  assertAddress(evidence.entryPoint, "entryPoint");
  assertBundlers(evidence.bundlers, evidence.network.chainId, evidence.entryPoint);
  assertChecks(evidence.checks);
  assertReceipts(evidence.receipts);

  return {
    chainId: evidence.network.chainId,
    entryPoint: evidence.entryPoint,
    bundlers: evidence.bundlers.map(item => item.name)
  };
}

function assertNetwork(network) {
  assertObject(network, "network");
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) {
    throw new Error("network.chainId must be positive");
  }
  if (!network.name || typeof network.name !== "string") throw new Error("network.name is required");
}

function assertBundlers(bundlers, chainId, entryPoint) {
  if (!Array.isArray(bundlers) || bundlers.length < 2) {
    throw new Error("bundler qualification requires at least two independent bundlers");
  }

  const names = new Set();
  const origins = new Set();
  const implementations = new Set();
  const operators = new Set();
  let hasPermissionlessEndpoint = false;

  for (const [index, bundler] of bundlers.entries()) {
    const label = `bundlers[${index}]`;
    assertObject(bundler, label);
    for (const key of ["name", "implementation", "operator", "rpcOrigin", "endpointKind", "chainId"]) {
      if (!(key in bundler)) throw new Error(`missing ${label}.${key}`);
    }

    for (const key of ["name", "implementation", "operator", "endpointKind"]) {
      if (!bundler[key] || typeof bundler[key] !== "string") throw new Error(`${label}.${key} is required`);
      if (bundler[key].toLowerCase().includes("loom")) throw new Error(`${label}.${key} must not be Loom-operated`);
    }

    if (!Number.isSafeInteger(bundler.chainId) || bundler.chainId !== chainId) {
      throw new Error(`${label}.chainId must match network.chainId`);
    }

    const origin = assertOrigin(bundler.rpcOrigin, `${label}.rpcOrigin`);
    names.add(bundler.name.toLowerCase());
    origins.add(origin);
    implementations.add(bundler.implementation.toLowerCase());
    operators.add(bundler.operator.toLowerCase());
    if (PERMISSIONLESS_ENDPOINT_KINDS.has(bundler.endpointKind.toLowerCase())) {
      hasPermissionlessEndpoint = true;
    }

    if (!Array.isArray(bundler.supportedEntryPoints)) throw new Error(`${label}.supportedEntryPoints must be an array`);
    const supportsExpected = bundler.supportedEntryPoints
      .map(value => String(value).toLowerCase())
      .includes(entryPoint.toLowerCase());
    if (!supportsExpected) throw new Error(`${label} does not support the expected EntryPoint`);

    assertObject(bundler.specTests, `${label}.specTests`);
    if (bundler.specTests.passed !== true) throw new Error(`${label}.specTests.passed must be true`);
    if (!bundler.specTests.reference || typeof bundler.specTests.reference !== "string") {
      throw new Error(`${label}.specTests.reference is required`);
    }
  }

  if (names.size !== bundlers.length) throw new Error("bundler names must be distinct");
  if (origins.size !== bundlers.length) throw new Error("bundler RPC origins must be distinct");
  if (implementations.size < 2) throw new Error("bundlers must use at least two implementations");
  if (operators.size < 2) throw new Error("bundlers must have at least two operators");
  if (!hasPermissionlessEndpoint) {
    throw new Error("qualification must include a local, self-hosted, or otherwise permissionless bundler path");
  }
}

function assertChecks(checks) {
  assertObject(checks, "checks");
  for (const key of REQUIRED_CHECKS) {
    if (checks[key] !== true) throw new Error(`missing passing bundler qualification check: ${key}`);
  }
}

function assertReceipts(receipts) {
  assertObject(receipts, "receipts");
  for (const key of ["deploy", "single", "batch", "nativeGas", "paymasterApproved", "directHandleOpsFallback"]) {
    assertTxHash(receipts[key], `receipts.${key}`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a URL origin`);
  }
  if (url.origin !== value || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  if (url.origin.toLowerCase().includes("loom")) throw new Error(`${label} must not be Loom-operated`);
  return url.origin.toLowerCase();
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertTxHash(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node tools/validate-bundler-qualification.mjs <evidence.json>");
  const summary = validateBundlerQualification(JSON.parse(await readFile(file, "utf8")));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
