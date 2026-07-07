import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!file) {
    throw new Error("usage: node tools/evidence/validate-live-rehearsal.mjs <evidence.json>");
  }
  const evidence = JSON.parse(await readFile(file, "utf8"));
  validateLiveRehearsal(evidence);
  console.log(`validated live rehearsal evidence for chain ${evidence.network.chainId}`);
}

export function validateLiveRehearsal(evidence) {
  const requiredTopLevel = [
    "version",
    "network",
    "contracts",
    "publishers",
    "tokens",
    "migration",
    "vault",
    "checks",
    "receipts"
  ];
  for (const key of requiredTopLevel) {
    if (!(key in evidence)) throw new Error(`missing top-level evidence field: ${key}`);
  }
  if (evidence.version !== 1) throw new Error("unsupported live rehearsal evidence version");

  assertNetwork(evidence.network);
  assertContracts(evidence.contracts);
  assertPublishers(evidence.publishers);
  assertTokens(evidence.tokens);
  assertMigration(evidence.migration);
  assertVault(evidence.vault);
  assertChecks(evidence.checks);
  assertReceipts(evidence.receipts);
}

function assertNetwork(network) {
  if (!network || typeof network !== "object") throw new Error("network must be an object");
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) throw new Error("network.chainId must be positive");
  if (!network.name || typeof network.name !== "string") throw new Error("network.name is required");
  if (!["ethereum", "op-stack", "arbitrum"].includes(network.family)) {
    throw new Error("network.family must be ethereum, op-stack, or arbitrum");
  }
  if (!network.rpcKind || typeof network.rpcKind !== "string") throw new Error("network.rpcKind is required");
  if (String(network.rpcKind).toLowerCase().includes("loom")) {
    throw new Error("live rehearsal evidence must not depend on a Loom-operated RPC");
  }
  if (!network.finality || typeof network.finality !== "object") throw new Error("network.finality is required");
  if (!Number.isSafeInteger(network.finality.minConfirmations) || network.finality.minConfirmations <= 0) {
    throw new Error("network.finality.minConfirmations must be positive");
  }
}

function assertContracts(contracts) {
  for (const key of ["sourceAccount", "destinationAccount", "entryPoint", "alternateEntryPointDestination"]) {
    assertAddress(contracts?.[key], `contracts.${key}`);
  }
  for (const key of ["sourceCodeHash", "destinationCodeHash"]) {
    assertBytes32(contracts?.[key], `contracts.${key}`);
  }
  if (contracts.sourceAccount === contracts.destinationAccount) {
    throw new Error("source and destination accounts must differ");
  }
}

function assertPublishers(publishers) {
  if (!Array.isArray(publishers) || publishers.length < 2) {
    throw new Error("live rehearsal must include at least two independent publishers");
  }
  const operators = new Set();
  for (const [index, publisher] of publishers.entries()) {
    const label = `publishers[${index}]`;
    for (const key of ["name", "operator", "kind", "origin"]) {
      if (!publisher[key] || typeof publisher[key] !== "string") throw new Error(`${label}.${key} is required`);
    }
    if (!["bundler", "public-rpc", "self-hosted-node"].includes(publisher.kind)) {
      throw new Error(`${label}.kind is invalid`);
    }
    if (publisher.operator.toLowerCase().includes("loom") || publisher.origin.toLowerCase().includes("loom")) {
      throw new Error(`${label} must not be Loom-operated`);
    }
    operators.add(publisher.operator.toLowerCase());
  }
  if (operators.size < 2) throw new Error("publishers must have independent operators");
}

function assertTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) {
    throw new Error("live rehearsal must include at least two real token assets");
  }
  const symbols = new Set();
  let hasStandard = false;
  let hasNonStandard = false;
  for (const [index, token] of tokens.entries()) {
    assertAddress(token.address, `tokens[${index}].address`);
    if (!token.symbol || typeof token.symbol !== "string") throw new Error(`tokens[${index}].symbol is required`);
    if (!Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      throw new Error(`tokens[${index}].decimals must be between 0 and 36`);
    }
    if (!token.testAmount || typeof token.testAmount !== "string" || !/^[1-9][0-9]*$/.test(token.testAmount)) {
      throw new Error(`tokens[${index}].testAmount must be a positive decimal string`);
    }
    if (symbols.has(token.symbol)) throw new Error(`duplicate token symbol: ${token.symbol}`);
    symbols.add(token.symbol);
    if (token.behavior === "standard") hasStandard = true;
    if (token.behavior === "non-standard") hasNonStandard = true;
    if (!["standard", "non-standard", "fee-on-transfer", "rebasing"].includes(token.behavior)) {
      throw new Error(`tokens[${index}].behavior is invalid`);
    }
  }
  if (!hasStandard) throw new Error("live rehearsal must include at least one standard token");
  if (!hasNonStandard) throw new Error("live rehearsal must include at least one non-standard token behavior");
}

function assertMigration(migration) {
  if (!migration || typeof migration !== "object") throw new Error("migration must be an object");
  if (!["new-loom-account", "alternate-entrypoint", "codehash-only-future-account"].includes(migration.destinationKind)) {
    throw new Error("migration.destinationKind is invalid");
  }
  for (const key of ["delaySeconds", "expirySeconds", "guardianCancellationThreshold"]) {
    if (!Number.isSafeInteger(migration[key]) || migration[key] <= 0) throw new Error(`migration.${key} must be positive`);
  }
  if (migration.expirySeconds <= migration.delaySeconds) {
    throw new Error("migration.expirySeconds must exceed migration.delaySeconds");
  }
}

function assertVault(vault) {
  if (!vault || typeof vault !== "object") throw new Error("vault must be an object");
  if (!Number.isSafeInteger(vault.withdrawalDelaySeconds) || vault.withdrawalDelaySeconds <= 0) {
    throw new Error("vault.withdrawalDelaySeconds must be positive");
  }
  if (!Array.isArray(vault.assets) || vault.assets.length < 2) {
    throw new Error("vault.assets must include native and token rehearsal assets");
  }
  const kinds = new Set();
  for (const [index, asset] of vault.assets.entries()) {
    const label = `vault.assets[${index}]`;
    if (!["native", "erc20"].includes(asset.kind)) throw new Error(`${label}.kind is invalid`);
    kinds.add(asset.kind);
    if (asset.kind === "erc20") assertAddress(asset.token, `${label}.token`);
  }
  if (!kinds.has("native") || !kinds.has("erc20")) {
    throw new Error("vault.assets must include native and erc20 assets");
  }
}

function assertChecks(checks) {
  const required = [
    "erc20PortfolioMigrated",
    "nonStandardTokenHandled",
    "guardianCancellationObserved",
    "expiryObserved",
    "alternativeEntryPointDestinationObserved",
    "independentPublishersObserved",
    "directExecutionFallbackObserved",
    "nativeExitFallbackObserved",
    "noLoomServiceRequired"
  ];
  for (const key of required) {
    if (checks?.[key] !== true) throw new Error(`missing passing live rehearsal check: ${key}`);
  }
}

function assertReceipts(receipts) {
  const required = [
    "sourceDeployment",
    "destinationDeployment",
    "portfolioFunding",
    "migrationSchedule",
    "guardianCancellation",
    "expiredMigration",
    "successfulMigration",
    "vaultSchedule",
    "vaultGuardianCancellation",
    "vaultExecution"
  ];
  for (const key of required) {
    assertTxHash(receipts?.[key], `receipts.${key}`);
  }
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

function assertBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) throw new Error(`${label} must be bytes32`);
}

function assertTxHash(value, label) {
  assertBytes32(value, label);
}
