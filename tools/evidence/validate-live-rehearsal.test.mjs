import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateLiveRehearsal } from "./validate-live-rehearsal.mjs";

test("live rehearsal evidence accepts migration vault and independent publisher proof", () => {
  validateLiveRehearsal(evidenceFor());
});

test("live rehearsal evidence rejects Loom-operated or single-operator publishers", () => {
  const loomPublisher = evidenceFor();
  loomPublisher.publishers[0].operator = "Loom";
  assert.throws(() => validateLiveRehearsal(loomPublisher), /must not be Loom-operated/);

  const singleOperator = evidenceFor();
  singleOperator.publishers[1].operator = singleOperator.publishers[0].operator;
  assert.throws(() => validateLiveRehearsal(singleOperator), /independent operators/);
});

test("live rehearsal evidence rejects weak token portfolio coverage", () => {
  const noNonStandard = evidenceFor();
  noNonStandard.tokens[1].behavior = "standard";
  assert.throws(() => validateLiveRehearsal(noNonStandard), /non-standard token behavior/);

  const badAmount = evidenceFor();
  badAmount.tokens[0].testAmount = "0";
  assert.throws(() => validateLiveRehearsal(badAmount), /testAmount/);
});

test("live rehearsal evidence rejects unsafe migration and vault windows", () => {
  const expiredBeforeDelay = evidenceFor();
  expiredBeforeDelay.migration.expirySeconds = expiredBeforeDelay.migration.delaySeconds;
  assert.throws(() => validateLiveRehearsal(expiredBeforeDelay), /expirySeconds must exceed/);

  const missingNativeVault = evidenceFor();
  missingNativeVault.vault.assets = [{ kind: "erc20", token: address("usdc") }];
  assert.throws(() => validateLiveRehearsal(missingNativeVault), /native and token rehearsal assets/);
});

test("live rehearsal evidence rejects missing production checks and receipts", () => {
  const missingCheck = evidenceFor();
  missingCheck.checks.independentPublishersObserved = false;
  assert.throws(() => validateLiveRehearsal(missingCheck), /independentPublishersObserved/);

  const missingReceipt = evidenceFor();
  delete missingReceipt.receipts.vaultExecution;
  assert.throws(() => validateLiveRehearsal(missingReceipt), /receipts.vaultExecution/);
});

function evidenceFor() {
  return {
    version: 1,
    network: {
      name: "base-sepolia",
      family: "op-stack",
      chainId: 84532,
      rpcKind: "public-rpc",
      finality: {
        minConfirmations: 12
      }
    },
    contracts: {
      sourceAccount: address("source"),
      destinationAccount: address("destination"),
      entryPoint: address("entry-point"),
      alternateEntryPointDestination: address("alternate-entry-point"),
      sourceCodeHash: bytes32("source-code"),
      destinationCodeHash: bytes32("destination-code")
    },
    publishers: [
      {
        name: "bundler-a",
        operator: "Independent Bundler A",
        kind: "bundler",
        origin: "https://bundler-a.example.invalid"
      },
      {
        name: "node-b",
        operator: "Independent Node B",
        kind: "self-hosted-node",
        origin: "https://node-b.example.invalid"
      }
    ],
    tokens: [
      {
        address: address("usdc"),
        symbol: "USDC",
        decimals: 6,
        behavior: "standard",
        testAmount: "1000000"
      },
      {
        address: address("usdt"),
        symbol: "USDT",
        decimals: 6,
        behavior: "non-standard",
        testAmount: "1000000"
      }
    ],
    migration: {
      destinationKind: "alternate-entrypoint",
      delaySeconds: 259200,
      expirySeconds: 604800,
      guardianCancellationThreshold: 2
    },
    vault: {
      withdrawalDelaySeconds: 259200,
      assets: [{ kind: "native" }, { kind: "erc20", token: address("usdc") }]
    },
    checks: {
      erc20PortfolioMigrated: true,
      nonStandardTokenHandled: true,
      guardianCancellationObserved: true,
      expiryObserved: true,
      alternativeEntryPointDestinationObserved: true,
      independentPublishersObserved: true,
      directExecutionFallbackObserved: true,
      nativeExitFallbackObserved: true,
      noLoomServiceRequired: true
    },
    receipts: {
      sourceDeployment: bytes32("source-deployment"),
      destinationDeployment: bytes32("destination-deployment"),
      portfolioFunding: bytes32("portfolio-funding"),
      migrationSchedule: bytes32("migration-schedule"),
      guardianCancellation: bytes32("guardian-cancellation"),
      expiredMigration: bytes32("expired-migration"),
      successfulMigration: bytes32("successful-migration"),
      vaultSchedule: bytes32("vault-schedule"),
      vaultGuardianCancellation: bytes32("vault-cancellation"),
      vaultExecution: bytes32("vault-execution")
    }
  };
}

function address(seed) {
  return `0x${bytes32(seed).slice(2, 42)}`;
}

function bytes32(seed) {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}
