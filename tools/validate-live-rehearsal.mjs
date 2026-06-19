import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  throw new Error("usage: node tools/validate-live-rehearsal.mjs <evidence.json>");
}

const evidence = JSON.parse(await readFile(file, "utf8"));
const requiredTopLevel = ["version", "network", "contracts", "tokens", "checks", "receipts"];
for (const key of requiredTopLevel) {
  if (!(key in evidence)) throw new Error(`missing top-level evidence field: ${key}`);
}
if (evidence.version !== 1) throw new Error("unsupported live rehearsal evidence version");

assertNetwork(evidence.network);
assertContracts(evidence.contracts);
assertTokens(evidence.tokens);
assertChecks(evidence.checks);
assertReceipts(evidence.receipts);

console.log(`validated live rehearsal evidence for chain ${evidence.network.chainId}`);

function assertNetwork(network) {
  if (!network || typeof network !== "object") throw new Error("network must be an object");
  if (!Number.isSafeInteger(network.chainId) || network.chainId <= 0) throw new Error("network.chainId must be positive");
  if (!network.name || typeof network.name !== "string") throw new Error("network.name is required");
  if (!network.rpcKind || typeof network.rpcKind !== "string") throw new Error("network.rpcKind is required");
  if (String(network.rpcKind).toLowerCase().includes("loom")) {
    throw new Error("live rehearsal evidence must not depend on a Loom-operated RPC");
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

function assertTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) {
    throw new Error("live rehearsal must include at least two real token assets");
  }
  const symbols = new Set();
  let hasNonStandard = false;
  for (const [index, token] of tokens.entries()) {
    assertAddress(token.address, `tokens[${index}].address`);
    if (!token.symbol || typeof token.symbol !== "string") throw new Error(`tokens[${index}].symbol is required`);
    if (symbols.has(token.symbol)) throw new Error(`duplicate token symbol: ${token.symbol}`);
    symbols.add(token.symbol);
    if (token.behavior === "non-standard") hasNonStandard = true;
    if (!["standard", "non-standard", "fee-on-transfer", "rebasing"].includes(token.behavior)) {
      throw new Error(`tokens[${index}].behavior is invalid`);
    }
  }
  if (!hasNonStandard) throw new Error("live rehearsal must include at least one non-standard token behavior");
}

function assertChecks(checks) {
  const required = [
    "erc20PortfolioMigrated",
    "nonStandardTokenHandled",
    "guardianCancellationObserved",
    "expiryObserved",
    "alternativeEntryPointDestinationObserved",
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
