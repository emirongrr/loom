import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsentRequiredError,
  createMemoryStorage,
  runRailgunLiveRehearsal
} from "../src/index.js";
import {
  buildRailgunRehearsalEvidence,
  rejectSecrets
} from "../../../scripts/privacy/run-railgun-rehearsal.mjs";
import { validatePrivacyAdapterProfile } from "../../../tools/evidence/validate-privacy-adapter-profile.mjs";

const bytes32 = `0x${"11".repeat(32)}`;
const account = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const pool = "0x3333333333333333333333333333333333333333";

function baseOptions(overrides = {}) {
  const storage = createMemoryStorage();
  return {
    confirmLiveNetwork: true,
    providerConsentConfirmed: true,
    mockProtocol: false,
    storage,
    providerProfile: {
      mode: "user-rpc",
      chainId: 1,
      endpoint: "https://rpc.example",
      verified: false,
      metadataBudget: {
        protocol: "railgun",
        chainId: 1,
        items: [
          {
            surface: "rpc",
            reveals: "selected chain and request timing",
            required: true,
            mitigation: "user-selected endpoint"
          },
          {
            surface: "indexer",
            reveals: "private note sync window",
            required: true,
            mitigation: "incremental local checkpoints"
          },
          {
            surface: "relayer",
            reveals: "broadcast timing for private operation",
            required: true,
            mitigation: "relayer is optional and user-selected"
          },
          {
            surface: "prover",
            reveals: "proof generation timing",
            required: true,
            mitigation: "proof generation can be local or user-selected"
          }
        ]
      }
    },
    metadataPolicy: {
      allowedSurfaces: ["rpc", "indexer", "relayer", "prover"],
      requireKnownMitigation: true
    },
    context: {
      account,
      chainId: 1,
      applicationId: "merchant",
      scanScope: "payments"
    },
    dependency: {
      version: "0.0.1-alpha.26",
      auditReviewed: true,
      licenseReviewed: true,
      lockfilePinned: true,
      reviewReference: "docs/operations/privacy-adapter-profile.md"
    },
    provider: {
      mode: "user-rpc",
      defaultEndpoint: false,
      requiresConsent: true,
      verifiedReads: false,
      degradedModeDocumented: true
    },
    metadata: {
      requiredSurfaces: ["rpc", "indexer", "relayer", "prover"],
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
      reindexFromGenesisOnStartup: false,
      initial: {
        toBlock: 10n,
        latestMerkleRoot: `0x${"12".repeat(32)}`,
        updatedAt: 1000
      },
      final: {
        fromBlock: 10n,
        toBlock: 12n,
        latestMerkleRoot: `0x${"13".repeat(32)}`,
        updatedAt: 1001
      }
    },
    operations: {
      shield: operation("shield", "0zkreceiver"),
      privateTransfer: operation("privateTransfer", "0zkrecipient"),
      unshield: operation("unshield", account),
      vaultProtectedUnshield: {
        privateOperationHash: `0x${"21".repeat(32)}`,
        vaultIntentHash: `0x${"22".repeat(32)}`,
        scheduleTxHash: `0x${"23".repeat(32)}`,
        executeTxHash: `0x${"24".repeat(32)}`,
        delaySeconds: 86400
      }
    },
    operationPolicy: {
      shield: policy(),
      privateTransfer: policy(),
      unshield: {
        ...policy(),
        vaultDelayForProtectedAssets: true
      }
    },
    failureProbes: {
      indexer: { tested: true, classified: true },
      relayer: { tested: true, classified: true },
      prover: { tested: true, classified: true },
      rpc: { tested: true, classified: true },
      timing: { tested: true, classified: true }
    },
    services: {
      indexer: service("https://indexer.example"),
      relayer: service("https://relayer.example"),
      prover: service("https://prover.example")
    },
    network: {
      environment: "testnet",
      name: "Ethereum testnet"
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
    },
    fetch: async () => new Response("{}"),
    createPlugin: async () => ({
      async instanceId() {
        return "0zkloom";
      },
      async balance() {
        return [
          {
            asset: `erc20:${token}`,
            amount: 10n,
            verified: true
          }
        ];
      },
      async prepareShield() {
        return [
          {
            to: pool,
            value: 0n,
            data: "0x1234"
          }
        ];
      },
      async prepareTransfer() {
        return {
          txid: "private-transfer"
        };
      },
      async prepareUnshield() {
        return {
          txid: "unshield"
        };
      },
      async broadcast() {
        return { status: "broadcasted" };
      }
    }),
    ...overrides
  };
}

function operation(kind, recipient) {
  return {
    asset: token,
    amount: 1n,
    recipient,
    operationId: `${kind}-live-rehearsal`,
    permissionHash: bytes32,
    expiry: 4102444800,
    maxFeeBound: true,
    receiptStatus: "success"
  };
}

function policy() {
  return {
    enabled: true,
    permissionBound: true,
    maxFeeBound: true,
    expiryBound: true
  };
}

function service(origin) {
  return {
    kind: "self-hosted",
    mandatory: false,
    origin,
    failureModeTested: true,
    failureClassified: true
  };
}

test("railgun live rehearsal emits validator-compatible evidence", async () => {
  const evidence = await runRailgunLiveRehearsal(baseOptions());

  assert.equal(evidence.protocol, "railgun");
  assert.equal(evidence.rehearsal.sdkIntegration.mockProtocol, false);
  assert.equal(evidence.rehearsal.operations.unshield.receiptStatus, "success");
  assert.equal(evidence.rehearsal.localScan.staleCheckpointRejected, true);
  assert.equal(evidence.observed.balanceCount, 1);
  validatePrivacyAdapterProfile(evidence);
});

test("railgun live rehearsal requires explicit live network confirmation", async () => {
  await assert.rejects(
    runRailgunLiveRehearsal(baseOptions({ confirmLiveNetwork: false })),
    ConsentRequiredError
  );
});

test("railgun live rehearsal rejects mock protocol evidence", async () => {
  await assert.rejects(
    runRailgunLiveRehearsal(baseOptions({ mockProtocol: true })),
    /must not use a mock protocol/
  );
});

test("railgun rehearsal script validates evidence before writing", async () => {
  const evidence = await buildRailgunRehearsalEvidence(baseOptions());
  assert.equal(evidence.protocol, "railgun");
  validatePrivacyAdapterProfile(evidence);

  const invalid = baseOptions({
    dependency: {
      ...baseOptions().dependency,
      auditReviewed: false
    }
  });
  await assert.rejects(
    () => buildRailgunRehearsalEvidence(invalid),
    /dependency.auditReviewed must be true/
  );
});

test("railgun rehearsal script rejects secret material in local config", () => {
  assert.throws(
    () => rejectSecrets({ nested: { viewingKey: "must-not-commit" } }),
    /viewingKey must not be present/
  );
  assert.throws(
    () => rejectSecrets({ note: "contains seed phrase material" }),
    /secret material/
  );
});
