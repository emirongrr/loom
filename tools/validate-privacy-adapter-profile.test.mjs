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
