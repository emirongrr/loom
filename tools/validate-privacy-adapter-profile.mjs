import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PROTOCOLS = new Set(["railgun", "privacy-pool", "aztec"]);
const SURFACES = new Set(["rpc", "indexer", "relayer", "prover", "bridge", "timing", "browser-storage", "backup"]);
const REQUIRED_CHECKS = [
  "noDefaultProvider",
  "explicitConsent",
  "metadataBudgetEnforced",
  "localScanState",
  "staleScanRejected",
  "indexerFailureDoesNotCheckpoint",
  "relayerFailureClassified",
  "proverFailureClassified",
  "permissionBinding",
  "vaultInteractionRehearsed",
  "nativeExitFallback",
  "noMandatoryLoomService",
  "noAccountAuthorityGranted"
];

const file = process.argv[2];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!file) {
    throw new Error("usage: node tools/validate-privacy-adapter-profile.mjs <profile.json>");
  }
  const profile = JSON.parse(await readFile(file, "utf8"));
  validatePrivacyAdapterProfile(profile);
  console.log(`validated privacy adapter profile for ${profile.protocol} on chain ${profile.chainId}`);
}

export function validatePrivacyAdapterProfile(profile) {
  assertTopLevel(profile);
  assertProtocol(profile.protocol);
  assertChainId(profile.chainId);
  assertDependency(profile.dependency, profile.protocol);
  assertProvider(profile.provider);
  assertMetadata(profile.metadata);
  assertScan(profile.scan);
  assertOperations(profile.operations, profile.protocol);
  assertFailures(profile.failures);
  assertChecks(profile.checks, profile.protocol);
}

function assertTopLevel(profile) {
  for (const key of [
    "version",
    "protocol",
    "chainId",
    "dependency",
    "provider",
    "metadata",
    "scan",
    "operations",
    "failures",
    "checks"
  ]) {
    if (!(key in profile)) throw new Error(`missing top-level privacy adapter profile field: ${key}`);
  }
  if (profile.version !== 1) throw new Error("unsupported privacy adapter profile version");
}

function assertProtocol(protocol) {
  if (!PROTOCOLS.has(protocol)) throw new Error("protocol must be railgun, privacy-pool, or aztec");
}

function assertChainId(chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chainId must be positive");
}

function assertDependency(dependency, protocol) {
  assertObject(dependency, "dependency");
  if (typeof dependency.package !== "string" || dependency.package.length === 0) {
    throw new Error("dependency.package is required");
  }
  const expected = {
    railgun: "@kohaku-eth/railgun",
    "privacy-pool": "@kohaku-eth/privacy-pools",
    aztec: "@aztec/aztec.js"
  };
  if (dependency.package !== expected[protocol]) {
    throw new Error(`dependency.package must be ${expected[protocol]}`);
  }
  if (typeof dependency.version !== "string" || dependency.version.length === 0) {
    throw new Error("dependency.version is required");
  }
  if (dependency.auditReviewed !== true) throw new Error("dependency.auditReviewed must be true");
  if (dependency.licenseReviewed !== true) throw new Error("dependency.licenseReviewed must be true");
  if (dependency.lockfilePinned !== true) throw new Error("dependency.lockfilePinned must be true");
  if (!dependency.reviewReference || typeof dependency.reviewReference !== "string") {
    throw new Error("dependency.reviewReference is required");
  }
}

function assertProvider(provider) {
  assertObject(provider, "provider");
  if (!["user-rpc", "local-node", "helios", "colibri", "custom"].includes(provider.mode)) {
    throw new Error("provider.mode is invalid");
  }
  if (provider.defaultEndpoint !== false) throw new Error("provider.defaultEndpoint must be false");
  if (provider.requiresConsent !== true) throw new Error("provider.requiresConsent must be true");
  if (provider.verifiedReads !== true && provider.degradedModeDocumented !== true) {
    throw new Error("provider must either verify reads or document degraded mode");
  }
}

function assertMetadata(metadata) {
  assertObject(metadata, "metadata");
  if (!Array.isArray(metadata.requiredSurfaces) || metadata.requiredSurfaces.length === 0) {
    throw new Error("metadata.requiredSurfaces must be non-empty");
  }
  for (const surface of metadata.requiredSurfaces) {
    if (!SURFACES.has(surface)) throw new Error(`unknown metadata surface: ${surface}`);
  }
  if (metadata.requiredSurfaces.includes("backup")) {
    throw new Error("backup metadata surface must not be required");
  }
  if (metadata.disclosesViewingKey !== false) throw new Error("metadata.disclosesViewingKey must be false");
  if (metadata.disclosesAccountGraph !== false) throw new Error("metadata.disclosesAccountGraph must be false");
  if (metadata.telemetryDisabled !== true) throw new Error("metadata.telemetryDisabled must be true");
  if (metadata.budgetTestsPassed !== true) throw new Error("metadata.budgetTestsPassed must be true");
}

function assertScan(scan) {
  assertObject(scan, "scan");
  if (scan.localFirst !== true) throw new Error("scan.localFirst must be true");
  if (scan.incrementalCheckpoints !== true) throw new Error("scan.incrementalCheckpoints must be true");
  if (scan.scopedByApplication !== true) throw new Error("scan.scopedByApplication must be true");
  if (scan.staleStatePolicy !== "fail-closed") throw new Error("scan.staleStatePolicy must be fail-closed");
  if (scan.reindexFromGenesisOnStartup !== false) throw new Error("scan.reindexFromGenesisOnStartup must be false");
}

function assertOperations(operations, protocol) {
  assertObject(operations, "operations");
  for (const key of ["shield", "privateTransfer", "unshield"]) {
    assertObject(operations[key], `operations.${key}`);
    if (operations[key].enabled !== true) throw new Error(`operations.${key}.enabled must be true`);
    if (operations[key].permissionBound !== true) throw new Error(`operations.${key}.permissionBound must be true`);
    if (operations[key].maxFeeBound !== true) throw new Error(`operations.${key}.maxFeeBound must be true`);
    if (operations[key].expiryBound !== true) throw new Error(`operations.${key}.expiryBound must be true`);
  }
  if (operations.unshield.vaultDelayForProtectedAssets !== true) {
    throw new Error("operations.unshield.vaultDelayForProtectedAssets must be true");
  }
  if (protocol === "aztec" && operations.unshield.bridgeFinalityDocumented !== true) {
    throw new Error("aztec unshield requires bridge finality documentation");
  }
}

function assertFailures(failures) {
  assertObject(failures, "failures");
  for (const key of ["indexer", "relayer", "prover", "rpc", "timing"]) {
    assertObject(failures[key], `failures.${key}`);
    if (failures[key].classified !== true) throw new Error(`failures.${key}.classified must be true`);
    if (failures[key].tested !== true) throw new Error(`failures.${key}.tested must be true`);
  }
  if (failures.indexer.mutatesCheckpointOnFailure !== false) {
    throw new Error("failures.indexer.mutatesCheckpointOnFailure must be false");
  }
  if (failures.relayer.mandatory !== false) throw new Error("failures.relayer.mandatory must be false");
}

function assertChecks(checks, protocol) {
  assertObject(checks, "checks");
  for (const key of REQUIRED_CHECKS) {
    if (checks[key] !== true) throw new Error(`missing passing privacy adapter check: ${key}`);
  }
  if (protocol === "aztec" && checks.bridgeFinalityReviewed !== true) {
    throw new Error("aztec privacy adapter requires bridgeFinalityReviewed");
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
