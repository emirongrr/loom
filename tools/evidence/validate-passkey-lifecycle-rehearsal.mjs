import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!file) throw new Error("usage: node tools/evidence/validate-passkey-lifecycle-rehearsal.mjs <evidence.json>");
  const evidence = JSON.parse(await readFile(file, "utf8"));
  validatePasskeyLifecycleRehearsal(evidence);
  console.log(`validated passkey lifecycle rehearsal for ${evidence.account}`);
}

export function validatePasskeyLifecycleRehearsal(evidence) {
  for (const key of ["version", "network", "deploymentManifestHash", "account", "accountHandle", "activation", "discovery", "recovery", "oldKey", "receipts"]) {
    if (!(key in (evidence ?? {}))) throw new Error(`missing lifecycle evidence field: ${key}`);
  }
  if (evidence.version !== 1) throw new Error("unsupported passkey lifecycle evidence version");
  if (evidence.network?.name !== "sepolia" || evidence.network?.chainId !== 11155111) throw new Error("lifecycle rehearsal must target Sepolia");
  if (!Number.isSafeInteger(evidence.network.referenceBlock) || evidence.network.referenceBlock <= 0) throw new Error("network.referenceBlock must be positive");
  bytes32(evidence.deploymentManifestHash, "deploymentManifestHash");
  address(evidence.account, "account");
  bytes32(evidence.accountHandle, "accountHandle");

  if (evidence.activation?.sponsored !== true || evidence.activation?.privateSubmission !== true) {
    throw new Error("activation must prove sponsored private submission");
  }
  address(evidence.activation.paymaster, "activation.paymaster");
  if (!evidence.activation.policyId || typeof evidence.activation.policyId !== "string") throw new Error("activation.policyId is required");
  bytes32(evidence.activation.policyHash, "activation.policyHash");
  bytes32(evidence.activation.privateProviderQualificationHash, "activation.privateProviderQualificationHash");
  if (evidence.activation.publicFallbackUsed !== false) throw new Error("canonical rehearsal must not use public fallback");

  for (const phase of ["originalKeySecondDevice", "recoveryKeySecondDevice"]) {
    const discovery = evidence.discovery?.[phase];
    if (discovery?.resolvedAccount?.toLowerCase() !== evidence.account.toLowerCase()) throw new Error(`${phase} resolved another account`);
    if (discovery?.userHandleMatched !== true || discovery?.liveValidatorAssertionVerified !== true) {
      throw new Error(`${phase} must prove locator and live-validator assertion`);
    }
    bytes32(discovery.credentialCommitment, `${phase}.credentialCommitment`);
  }
  if (evidence.discovery?.registryAgreementAcrossIndependentRpcs !== true) throw new Error("independent registry agreement is required");

  if (!Number.isSafeInteger(evidence.recovery?.configuredDelaySeconds) || evidence.recovery.configuredDelaySeconds <= 0) {
    throw new Error("recovery.configuredDelaySeconds must be positive");
  }
  if (!Number.isSafeInteger(evidence.recovery.observedDelaySeconds)
      || evidence.recovery.observedDelaySeconds < evidence.recovery.configuredDelaySeconds) {
    throw new Error("recovery delay was not fully observed");
  }
  if (evidence.recovery.guardianThresholdSatisfied !== true || evidence.recovery.newValidatorLive !== true) {
    throw new Error("recovery quorum and new live validator must be proved");
  }
  if (evidence.oldKey?.rejected !== true || evidence.oldKey?.reason !== "live-validator-mismatch") {
    throw new Error("old key rejection must be caused by live-validator mismatch");
  }

  for (const key of ["sponsoredActivation", "guardianSetup", "recoveryIntent", "recoveryExecution", "recoveredKeySend"]) {
    receipt(evidence.receipts?.[key], `receipts.${key}`);
  }
}

function receipt(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  bytes32(value.transactionHash, `${label}.transactionHash`);
  bytes32(value.userOperationHash, `${label}.userOperationHash`);
  if (!Number.isSafeInteger(value.blockNumber) || value.blockNumber <= 0) throw new Error(`${label}.blockNumber must be positive`);
  if (value.success !== true) throw new Error(`${label}.success must be true`);
}
function address(value, label) { if (!/^0x[0-9a-fA-F]{40}$/u.test(value ?? "")) throw new Error(`${label} must be an address`); }
function bytes32(value, label) { if (!/^0x[0-9a-fA-F]{64}$/u.test(value ?? "")) throw new Error(`${label} must be bytes32`); }
