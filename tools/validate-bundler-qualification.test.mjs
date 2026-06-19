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
