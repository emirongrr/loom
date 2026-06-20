import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PROTOCOLS = new Set(["railgun", "privacy-pool", "aztec"]);
const SURFACES = new Set(["rpc", "indexer", "relayer", "prover", "bridge", "timing", "browser-storage", "backup"]);
const SERVICE_KINDS = new Set(["community", "self-hosted", "protocol", "third-party"]);
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
  assertRehearsal(profile.rehearsal, profile);
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
    "rehearsal",
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

function assertRehearsal(rehearsal, profile) {
  assertObject(rehearsal, "rehearsal");
  assertObject(rehearsal.network, "rehearsal.network");
  if (rehearsal.network.chainId !== profile.chainId) {
    throw new Error("rehearsal.network.chainId must match profile.chainId");
  }
  if (!["testnet", "mainnet"].includes(rehearsal.network.environment)) {
    throw new Error("rehearsal.network.environment must be testnet or mainnet");
  }
  if (typeof rehearsal.network.name !== "string" || rehearsal.network.name.length === 0) {
    throw new Error("rehearsal.network.name is required");
  }

  assertObject(rehearsal.sdkIntegration, "rehearsal.sdkIntegration");
  if (rehearsal.sdkIntegration.package !== profile.dependency.package) {
    throw new Error("rehearsal.sdkIntegration.package must match dependency.package");
  }
  if (rehearsal.sdkIntegration.version !== profile.dependency.version) {
    throw new Error("rehearsal.sdkIntegration.version must match dependency.version");
  }
  if (rehearsal.sdkIntegration.mockProtocol !== false) {
    throw new Error("rehearsal.sdkIntegration.mockProtocol must be false");
  }
  if (rehearsal.sdkIntegration.kohakuHostBoundary !== true) {
    throw new Error("rehearsal.sdkIntegration.kohakuHostBoundary must be true");
  }
  if (typeof rehearsal.sdkIntegration.reference !== "string" || rehearsal.sdkIntegration.reference.length === 0) {
    throw new Error("rehearsal.sdkIntegration.reference is required");
  }

  assertObject(rehearsal.localScan, "rehearsal.localScan");
  assertBytes32(rehearsal.localScan.storageScopeHash, "rehearsal.localScan.storageScopeHash");
  assertBytes32(rehearsal.localScan.initialCheckpointHash, "rehearsal.localScan.initialCheckpointHash");
  assertBytes32(rehearsal.localScan.finalCheckpointHash, "rehearsal.localScan.finalCheckpointHash");
  if (rehearsal.localScan.initialCheckpointHash === rehearsal.localScan.finalCheckpointHash) {
    throw new Error("rehearsal.localScan must advance checkpoint");
  }
  if (rehearsal.localScan.staleCheckpointRejected !== true) {
    throw new Error("rehearsal.localScan.staleCheckpointRejected must be true");
  }
  if (rehearsal.localScan.resetScopedStateTested !== true) {
    throw new Error("rehearsal.localScan.resetScopedStateTested must be true");
  }

  assertObject(rehearsal.operations, "rehearsal.operations");
  assertOperationEvidence(rehearsal.operations.shield, "rehearsal.operations.shield");
  assertOperationEvidence(rehearsal.operations.privateTransfer, "rehearsal.operations.privateTransfer");
  assertOperationEvidence(rehearsal.operations.unshield, "rehearsal.operations.unshield");
  assertVaultEvidence(rehearsal.operations.vaultProtectedUnshield);

  assertObject(rehearsal.services, "rehearsal.services");
  assertServiceEvidence(rehearsal.services.indexer, "rehearsal.services.indexer");
  assertServiceEvidence(rehearsal.services.relayer, "rehearsal.services.relayer");
  assertServiceEvidence(rehearsal.services.prover, "rehearsal.services.prover");
}

function assertOperationEvidence(operation, label) {
  assertObject(operation, label);
  if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
    throw new Error(`${label}.operationId is required`);
  }
  assertBytes32(operation.metadataBudgetHash, `${label}.metadataBudgetHash`);
  assertBytes32(operation.permissionHash, `${label}.permissionHash`);
  if (!Number.isSafeInteger(operation.expiry) || operation.expiry <= 0) {
    throw new Error(`${label}.expiry must be positive`);
  }
  if (operation.maxFeeBound !== true) throw new Error(`${label}.maxFeeBound must be true`);
  if (operation.receiptStatus !== "success") throw new Error(`${label}.receiptStatus must be success`);
}

function assertVaultEvidence(vault) {
  assertObject(vault, "rehearsal.operations.vaultProtectedUnshield");
  assertBytes32(vault.privateOperationHash, "rehearsal.operations.vaultProtectedUnshield.privateOperationHash");
  assertBytes32(vault.vaultIntentHash, "rehearsal.operations.vaultProtectedUnshield.vaultIntentHash");
  assertTxHash(vault.scheduleTxHash, "rehearsal.operations.vaultProtectedUnshield.scheduleTxHash");
  assertTxHash(vault.executeTxHash, "rehearsal.operations.vaultProtectedUnshield.executeTxHash");
  if (!Number.isSafeInteger(vault.delaySeconds) || vault.delaySeconds <= 0) {
    throw new Error("rehearsal.operations.vaultProtectedUnshield.delaySeconds must be positive");
  }
}

function assertServiceEvidence(service, label) {
  assertObject(service, label);
  if (!SERVICE_KINDS.has(service.kind)) throw new Error(`${label}.kind is invalid`);
  if (service.mandatory !== false) throw new Error(`${label}.mandatory must be false`);
  assertOrigin(service.origin, `${label}.origin`);
  if (service.failureModeTested !== true) throw new Error(`${label}.failureModeTested must be true`);
  if (service.failureClassified !== true) throw new Error(`${label}.failureClassified must be true`);
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

function assertBytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
}

function assertTxHash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a transaction hash`);
  }
}

function assertOrigin(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL origin`);
  }
  if (url.origin !== value || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must be a URL origin without path, query, or fragment`);
  }
}
