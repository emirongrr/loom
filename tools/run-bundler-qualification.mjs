import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { smokeBundler } from "./bundler-smoke.mjs";
import { validateBundlerQualification } from "./validate-bundler-qualification.mjs";

export async function buildBundlerQualificationEvidence({ config, fetch: fetchImpl = fetch }) {
  assertObject(config, "config");
  for (const key of ["version", "network", "entryPoint", "bundlers", "lifecycle", "checks", "receipts"]) {
    if (!(key in config)) throw new Error(`missing qualification config field: ${key}`);
  }
  if (config.version !== 1) throw new Error("unsupported bundler qualification config version");
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

  const bundlers = [];
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
  }

  const evidence = Object.freeze({
    version: 1,
    network: cloneJson(config.network),
    entryPoint: config.entryPoint,
    bundlers: Object.freeze(bundlers),
    lifecycle: normalizeLifecycle(config.lifecycle, config.network.chainId, config.entryPoint),
    checks: cloneJson(config.checks),
    receipts: cloneJson(config.receipts),
    generatedAt: new Date().toISOString(),
    generator: "tools/run-bundler-qualification.mjs"
  });

  validateBundlerQualification(evidence);
  return evidence;
}

function normalizeLifecycle(lifecycle, chainId, entryPoint) {
  if (!Array.isArray(lifecycle)) throw new Error("lifecycle must be an array");
  return Object.freeze(lifecycle.map((item, index) => {
    const label = `lifecycle[${index}]`;
    assertObject(item, label);
    return Object.freeze({
      ...cloneJson(item),
      chainId,
      entryPoint
    });
  }));
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
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
    throw new Error("usage: node tools/run-bundler-qualification.mjs <config.json> [output.json]");
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
