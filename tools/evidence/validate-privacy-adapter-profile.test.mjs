import test from "node:test";
import assert from "node:assert/strict";
import { validatePrivacyAdapterProfile } from "./validate-privacy-adapter-profile.mjs";

test("privacy adapter profile accepts a production-candidate Railgun evidence shape", () => {
  validatePrivacyAdapterProfile(railgunProfile());
});

test("privacy adapter profile rejects default provider and missing consent", () => {
  const defaultProvider = railgunProfile();
  defaultProvider.provider.defaultEndpoint = true;
  assert.throws(() => validatePrivacyAdapterProfile(defaultProvider), /defaultEndpoint must be false/);

  const noConsent = railgunProfile();
  noConsent.provider.requiresConsent = false;
  assert.throws(() => validatePrivacyAdapterProfile(noConsent), /requiresConsent must be true/);
});

test("privacy adapter profile rejects secret and account graph disclosure", () => {
  const viewingKey = railgunProfile();
  viewingKey.metadata.disclosesViewingKey = true;
  assert.throws(() => validatePrivacyAdapterProfile(viewingKey), /disclosesViewingKey must be false/);

  const accountGraph = railgunProfile();
  accountGraph.metadata.disclosesAccountGraph = true;
  assert.throws(() => validatePrivacyAdapterProfile(accountGraph), /disclosesAccountGraph must be false/);
});

test("privacy adapter profile requires local scoped fail-closed scanning", () => {
  const staleOpen = railgunProfile();
  staleOpen.scan.staleStatePolicy = "warn-only";
  assert.throws(() => validatePrivacyAdapterProfile(staleOpen), /staleStatePolicy must be fail-closed/);

  const genesis = railgunProfile();
  genesis.scan.reindexFromGenesisOnStartup = true;
  assert.throws(() => validatePrivacyAdapterProfile(genesis), /reindexFromGenesisOnStartup must be false/);
});

test("privacy adapter profile requires unshield vault delay and failure classification", () => {
  const noVault = railgunProfile();
  noVault.operations.unshield.vaultDelayForProtectedAssets = false;
  assert.throws(() => validatePrivacyAdapterProfile(noVault), /vaultDelayForProtectedAssets/);

  const checkpointMutation = railgunProfile();
  checkpointMutation.failures.indexer.mutatesCheckpointOnFailure = true;
  assert.throws(() => validatePrivacyAdapterProfile(checkpointMutation), /mutatesCheckpointOnFailure must be false/);

  const mandatoryRelayer = railgunProfile();
  mandatoryRelayer.failures.relayer.mandatory = true;
  assert.throws(() => validatePrivacyAdapterProfile(mandatoryRelayer), /relayer.mandatory must be false/);
});

test("privacy adapter profile requires live SDK evidence rather than a mock protocol", () => {
  const mock = railgunProfile();
  mock.rehearsal.sdkIntegration.mockProtocol = true;
  assert.throws(() => validatePrivacyAdapterProfile(mock), /mockProtocol must be false/);

  const mismatch = railgunProfile();
  mismatch.rehearsal.sdkIntegration.package = "@kohaku-eth/privacy-pools";
  assert.throws(() => validatePrivacyAdapterProfile(mismatch), /sdkIntegration.package must match/);

  const noBoundary = railgunProfile();
  noBoundary.rehearsal.sdkIntegration.kohakuHostBoundary = false;
  assert.throws(() => validatePrivacyAdapterProfile(noBoundary), /kohakuHostBoundary must be true/);
});

test("privacy adapter profile requires advancing local scan evidence", () => {
  const stagnant = railgunProfile();
  stagnant.rehearsal.localScan.finalCheckpointHash = stagnant.rehearsal.localScan.initialCheckpointHash;
  assert.throws(() => validatePrivacyAdapterProfile(stagnant), /must advance checkpoint/);

  const staleAccepted = railgunProfile();
  staleAccepted.rehearsal.localScan.staleCheckpointRejected = false;
  assert.throws(() => validatePrivacyAdapterProfile(staleAccepted), /staleCheckpointRejected must be true/);
});

test("privacy adapter profile requires vault and service rehearsal evidence", () => {
  const noVaultExecute = railgunProfile();
  noVaultExecute.rehearsal.operations.vaultProtectedUnshield.executeTxHash = "0x1234";
  assert.throws(() => validatePrivacyAdapterProfile(noVaultExecute), /executeTxHash must be a transaction hash/);

  const mandatoryRelayer = railgunProfile();
  mandatoryRelayer.rehearsal.services.relayer.mandatory = true;
  assert.throws(() => validatePrivacyAdapterProfile(mandatoryRelayer), /rehearsal.services.relayer.mandatory must be false/);

  const leakyOrigin = railgunProfile();
  leakyOrigin.rehearsal.services.indexer.origin = "https://indexer.example/path?account=0xabc";
  assert.throws(() => validatePrivacyAdapterProfile(leakyOrigin), /origin must be a URL origin/);
});

test("privacy adapter profile rejects package mismatch and unreviewed dependencies", () => {
  const mismatch = railgunProfile();
  mismatch.dependency.package = "@kohaku-eth/privacy-pools";
  assert.throws(() => validatePrivacyAdapterProfile(mismatch), /dependency.package must be @kohaku-eth\/railgun/);

  const unaudited = railgunProfile();
  unaudited.dependency.auditReviewed = false;
  assert.throws(() => validatePrivacyAdapterProfile(unaudited), /auditReviewed must be true/);
});

test("privacy adapter profile accepts Aztec only with bridge finality review", () => {
  const aztec = railgunProfile();
  aztec.protocol = "aztec";
  aztec.dependency.package = "@aztec/aztec.js";
  aztec.rehearsal.sdkIntegration.package = "@aztec/aztec.js";
  aztec.operations.unshield.bridgeFinalityDocumented = true;
  aztec.checks.bridgeFinalityReviewed = true;

  validatePrivacyAdapterProfile(aztec);

  aztec.checks.bridgeFinalityReviewed = false;
  assert.throws(() => validatePrivacyAdapterProfile(aztec), /bridgeFinalityReviewed/);
});

function railgunProfile() {
  return {
    version: 1,
    protocol: "railgun",
    chainId: 1,
    dependency: {
      package: "@kohaku-eth/railgun",
      version: "0.0.1-alpha.26",
      auditReviewed: true,
      licenseReviewed: true,
      lockfilePinned: true,
      reviewReference: "docs/design/privacy-adapters.md"
    },
    provider: {
      mode: "user-rpc",
      defaultEndpoint: false,
      requiresConsent: true,
      verifiedReads: false,
      degradedModeDocumented: true
    },
    metadata: {
      requiredSurfaces: ["rpc", "indexer"],
      disclosesViewingKey: false,
      disclosesAccountGraph: false,
      telemetryDisabled: true,
      budgetTestsPassed: true
    },
    scan: {
      localFirst: true,
      incrementalCheckpoints: true,
      scopedByApplication: true,
      staleStatePolicy: "fail-closed",
      reindexFromGenesisOnStartup: false
    },
    operations: {
      shield: operation(),
      privateTransfer: operation(),
      unshield: {
        ...operation(),
        vaultDelayForProtectedAssets: true,
        bridgeFinalityDocumented: false
      }
    },
    failures: {
      indexer: {
        classified: true,
        tested: true,
        mutatesCheckpointOnFailure: false
      },
      relayer: {
        classified: true,
        tested: true,
        mandatory: false
      },
      prover: {
        classified: true,
        tested: true
      },
      rpc: {
        classified: true,
        tested: true
      },
      timing: {
        classified: true,
        tested: true
      }
    },
    rehearsal: {
      network: {
        chainId: 1,
        environment: "testnet",
        name: "sepolia"
      },
      sdkIntegration: {
        package: "@kohaku-eth/railgun",
        version: "0.0.1-alpha.26",
        mockProtocol: false,
        kohakuHostBoundary: true,
        reference: "evidence/privacy/railgun-sepolia-2026-06-20.json"
      },
      localScan: {
        storageScopeHash: bytes32("10"),
        initialCheckpointHash: bytes32("11"),
        finalCheckpointHash: bytes32("12"),
        staleCheckpointRejected: true,
        resetScopedStateTested: true
      },
      operations: {
        shield: operationEvidence("shield"),
        privateTransfer: operationEvidence("private-transfer"),
        unshield: operationEvidence("unshield"),
        vaultProtectedUnshield: {
          privateOperationHash: bytes32("30"),
          vaultIntentHash: bytes32("31"),
          scheduleTxHash: bytes32("32"),
          executeTxHash: bytes32("33"),
          delaySeconds: 86400
        }
      },
      services: {
        indexer: serviceEvidence("https://indexer.example"),
        relayer: serviceEvidence("https://relayer.example"),
        prover: serviceEvidence("https://prover.example")
      }
    },
    checks: {
      noDefaultProvider: true,
      explicitConsent: true,
      metadataBudgetEnforced: true,
      localScanState: true,
      staleScanRejected: true,
      indexerFailureDoesNotCheckpoint: true,
      relayerFailureClassified: true,
      proverFailureClassified: true,
      permissionBinding: true,
      vaultInteractionRehearsed: true,
      nativeExitFallback: true,
      noMandatoryLoomService: true,
      noAccountAuthorityGranted: true
    }
  };
}

function operation() {
  return {
    enabled: true,
    permissionBound: true,
    maxFeeBound: true,
    expiryBound: true
  };
}

function operationEvidence(operationId) {
  return {
    operationId,
    metadataBudgetHash: bytes32("20"),
    permissionHash: bytes32("21"),
    expiry: 1800,
    maxFeeBound: true,
    receiptStatus: "success"
  };
}

function serviceEvidence(origin) {
  return {
    kind: "third-party",
    mandatory: false,
    origin,
    failureModeTested: true,
    failureClassified: true
  };
}

function bytes32(byte) {
  return `0x${byte.repeat(32)}`;
}
