import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validatePasskeyLifecycleRehearsal } from "./validate-passkey-lifecycle-rehearsal.mjs";

test("accepts the complete sponsored onboarding and recovery lifecycle", () => {
  validatePasskeyLifecycleRehearsal(evidence());
});

test("rejects public fallback, stale-key acceptance, and a shortened recovery delay", () => {
  const fallback = evidence(); fallback.activation.publicFallbackUsed = true;
  assert.throws(() => validatePasskeyLifecycleRehearsal(fallback), /must not use public fallback/);
  const stale = evidence(); stale.oldKey.rejected = false;
  assert.throws(() => validatePasskeyLifecycleRehearsal(stale), /old key rejection/);
  const early = evidence(); early.recovery.observedDelaySeconds = 59;
  assert.throws(() => validatePasskeyLifecycleRehearsal(early), /delay was not fully observed/);
});

function evidence() {
  const account = address("account");
  const discovery = commitment => ({
    resolvedAccount: account, userHandleMatched: true, liveValidatorAssertionVerified: true,
    credentialCommitment: bytes32(commitment)
  });
  const tx = name => ({ transactionHash: bytes32(`${name}-tx`), userOperationHash: bytes32(`${name}-op`), blockNumber: 123, success: true });
  return {
    version: 1,
    network: { name: "sepolia", chainId: 11155111, referenceBlock: 123 },
    deploymentManifestHash: bytes32("manifest"), account, accountHandle: bytes32("handle"),
    activation: {
      sponsored: true, privateSubmission: true, paymaster: address("paymaster"),
      policyId: "loom-sepolia-onboarding-v1", policyHash: bytes32("policy"),
      privateProviderQualificationHash: bytes32("private-provider"), publicFallbackUsed: false
    },
    discovery: {
      originalKeySecondDevice: discovery("old-key"), recoveryKeySecondDevice: discovery("new-key"),
      registryAgreementAcrossIndependentRpcs: true
    },
    recovery: { configuredDelaySeconds: 60, observedDelaySeconds: 61, guardianThresholdSatisfied: true, newValidatorLive: true },
    oldKey: { rejected: true, reason: "live-validator-mismatch" },
    receipts: {
      sponsoredActivation: tx("activation"), guardianSetup: tx("guardians"), recoveryIntent: tx("intent"),
      recoveryExecution: tx("execute"), recoveredKeySend: tx("send")
    }
  };
}
function bytes32(seed) { return `0x${createHash("sha256").update(seed).digest("hex")}`; }
function address(seed) { return `0x${bytes32(seed).slice(2, 42)}`; }
