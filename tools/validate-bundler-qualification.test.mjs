import test from "node:test";
import assert from "node:assert/strict";
import { validateBundlerQualification } from "./validate-bundler-qualification.mjs";

const ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TX = "0x" + "11".repeat(32);

function validEvidence() {
  return {
    version: 1,
    network: { name: "sepolia", chainId: 11155111 },
    entryPoint: ENTRYPOINT,
    bundlers: [
      {
        name: "local-rundler",
        implementation: "rundler",
        operator: "self-hosted",
        rpcOrigin: "https://bundler-a.example",
        endpointKind: "self-hosted",
        chainId: 11155111,
        supportedEntryPoints: [ENTRYPOINT],
        specTests: { passed: true, reference: "eth-infinitism/bundler-spec-tests@sha" }
      },
      {
        name: "third-party-skandha",
        implementation: "skandha",
        operator: "independent-operator",
        rpcOrigin: "https://bundler-b.example",
        endpointKind: "api",
        chainId: 11155111,
        supportedEntryPoints: [ENTRYPOINT],
        specTests: { passed: true, reference: "eth-infinitism/bundler-spec-tests@sha" }
      }
    ],
    lifecycle: [
      lifecycleFor("local-rundler"),
      lifecycleFor("third-party-skandha")
    ],
    checks: {
      counterfactualDeploy: true,
      singleUserOperation: true,
      atomicBatchUserOperation: true,
      nativeGas: true,
      paymasterApproved: true,
      paymasterRejected: true,
      invalidSignatureRejected: true,
      staleNonceRejected: true,
      malformedCalldataRejected: true,
      unsupportedModeRejected: true,
      receiptReconciliation: true,
      permissionlessHandleOpsFallback: true
    },
    receipts: {
      deploy: TX,
      single: TX,
      batch: TX,
      nativeGas: TX,
      paymasterApproved: TX,
      directHandleOpsFallback: TX
    }
  };
}

function lifecycleFor(bundler) {
  return {
    bundler,
    chainId: 11155111,
    entryPoint: ENTRYPOINT,
    account: "0x" + "33".repeat(20),
    checks: {
      counterfactualDeploy: true,
      singleUserOperation: true,
      atomicBatchUserOperation: true,
      nativeGas: true,
      paymasterApproved: true,
      paymasterRejected: true,
      invalidSignatureRejected: true,
      staleNonceRejected: true,
      malformedCalldataRejected: true,
      unsupportedModeRejected: true,
      receiptReconciliation: true
    },
    stages: {
      session: stage(),
      recovery: stage(),
      migration: stage(),
      vault: stage()
    },
    receipts: {
      deploy: TX,
      single: TX,
      batch: TX,
      nativeGas: TX,
      paymasterApproved: TX,
      paymasterRejected: TX,
      sessionGrant: TX,
      sessionRevoke: TX,
      recoveryProposal: TX,
      recoveryCancel: TX,
      migrationSchedule: TX,
      migrationCancel: TX,
      vaultSchedule: TX,
      vaultCancel: TX
    }
  };
}

function stage() {
  return {
    scheduled: true,
    cancelled: true,
    configBound: true,
    receiptReconciled: true
  };
}

test("bundler qualification requires two independent implementations and operators", () => {
  const evidence = validEvidence();
  assert.deepEqual(validateBundlerQualification(evidence), {
    chainId: 11155111,
    entryPoint: ENTRYPOINT,
    bundlers: ["local-rundler", "third-party-skandha"]
  });

  evidence.bundlers[1].implementation = "rundler";
  assert.throws(() => validateBundlerQualification(evidence), /at least two implementations/);
});

test("bundler qualification rejects shared origins and secret-bearing URLs", () => {
  const evidence = validEvidence();
  evidence.bundlers[1].rpcOrigin = "https://bundler-a.example";
  assert.throws(() => validateBundlerQualification(evidence), /origins must be distinct/);

  evidence.bundlers[1].rpcOrigin = "https://bundler-b.example/api-key";
  assert.throws(() => validateBundlerQualification(evidence), /must be an origin/);
});

test("bundler qualification requires permissionless fallback and lifecycle checks", () => {
  const evidence = validEvidence();
  evidence.bundlers[0].endpointKind = "api";
  assert.throws(() => validateBundlerQualification(evidence), /permissionless bundler path/);

  evidence.bundlers[0].endpointKind = "local";
  evidence.checks.permissionlessHandleOpsFallback = false;
  assert.throws(() => validateBundlerQualification(evidence), /permissionlessHandleOpsFallback/);
});

test("bundler qualification binds chain and expected entrypoint", () => {
  const evidence = validEvidence();
  evidence.bundlers[1].chainId = 1;
  assert.throws(() => validateBundlerQualification(evidence), /chainId must match/);

  evidence.bundlers[1].chainId = 11155111;
  evidence.bundlers[1].supportedEntryPoints = ["0x" + "22".repeat(20)];
  assert.throws(() => validateBundlerQualification(evidence), /expected EntryPoint/);
});

test("bundler qualification requires each bundler to pass the same account lifecycle", () => {
  const missing = validEvidence();
  missing.lifecycle.pop();
  assert.throws(() => validateBundlerQualification(missing), /one result per bundler/);

  const wrongBundler = validEvidence();
  wrongBundler.lifecycle[1].bundler = "unknown-bundler";
  assert.throws(() => validateBundlerQualification(wrongBundler), /must match a qualified bundler/);

  const differentAccount = validEvidence();
  differentAccount.lifecycle[1].account = "0x" + "44".repeat(20);
  assert.throws(() => validateBundlerQualification(differentAccount), /same account across bundlers/);

  const missingLifecycleCheck = validEvidence();
  missingLifecycleCheck.lifecycle[0].checks.atomicBatchUserOperation = false;
  assert.throws(() => validateBundlerQualification(missingLifecycleCheck), /atomicBatchUserOperation/);
});

test("bundler qualification requires lifecycle stage and receipt evidence", () => {
  const missingStage = validEvidence();
  delete missingStage.lifecycle[0].stages.recovery;
  assert.throws(() => validateBundlerQualification(missingStage), /stages.recovery must be an object/);

  const unboundVault = validEvidence();
  unboundVault.lifecycle[0].stages.vault.configBound = false;
  assert.throws(() => validateBundlerQualification(unboundVault), /stages.vault.configBound must be true/);

  const missingReceipt = validEvidence();
  delete missingReceipt.lifecycle[0].receipts.sessionRevoke;
  assert.throws(() => validateBundlerQualification(missingReceipt), /receipts.sessionRevoke must be bytes32/);

  const missingCancellation = validEvidence();
  missingCancellation.lifecycle[0].stages.migration.cancelled = false;
  assert.throws(() => validateBundlerQualification(missingCancellation), /stages.migration.cancelled must be true/);
});
