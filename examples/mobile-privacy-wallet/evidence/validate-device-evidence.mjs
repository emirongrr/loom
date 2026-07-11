import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Physical-device evidence validator for the mobile privacy wallet.
//
// A store release of this wallet cannot be claimed from source alone: the
// passkey, domain-policy, Helios, and hygiene properties must be proven on real
// iOS and Android devices (GAPS.md G-001, G-001A, G-006, G-009). This validator
// checks that a completed evidence bundle is structurally complete AND honest:
// it rejects a bundle that claims a property the platform cannot provide (iOS
// screenshot blocking), that persists forbidden material (raw credential ids,
// attestation objects), or whose native domain policy diverges from the pinned
// relying-party configuration.
//
// The template `evidence/device-evidence.template.json` is filled in during a
// device session; running this validator against it fails until every field is
// truthfully completed.

const PLATFORMS = ["ios", "android"];
const HEX32 = /^0x[0-9a-fA-F]{64}$/u;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    throw new Error("usage: node evidence/validate-device-evidence.mjs <evidence.json>");
  }
  const evidence = JSON.parse(await readFile(file, "utf8"));
  validateDeviceEvidence(evidence);
  console.log(`validated device evidence for ${evidence.app.bundleIdentifier} (${evidence.app.buildType} build)`);
}

export function validateDeviceEvidence(evidence) {
  assertTopLevel(evidence);
  assertApp(evidence.app);
  assertPasskey(evidence.passkey); // G-001
  assertDomainPolicy(evidence.domainPolicy); // G-001A
  assertHelios(evidence.helios); // G-006
  assertHygiene(evidence.hygiene); // G-009
}

function assertTopLevel(evidence) {
  if (!evidence || typeof evidence !== "object") throw new Error("evidence must be an object");
  for (const key of ["version", "app", "passkey", "domainPolicy", "helios", "hygiene"]) {
    if (!(key in evidence)) throw new Error(`missing top-level device evidence field: ${key}`);
  }
  if (evidence.version !== 1) throw new Error("unsupported device evidence version");
}

function assertApp(app) {
  requireObject(app, "app");
  requireNonEmptyString(app.bundleIdentifier, "app.bundleIdentifier");
  if (app.buildType !== "release") throw new Error("app.buildType must be release (device evidence is release evidence)");
}

// G-001: physical-device passkey registration/assertion, no persisted secrets.
function assertPasskey(passkey) {
  requireObject(passkey, "passkey");
  const platforms = requirePlatformArray(passkey.platforms, "passkey.platforms");
  for (const entry of platforms) {
    const label = `passkey.platforms[${entry.platform}]`;
    requireNonEmptyString(entry.osVersion, `${label}.osVersion`);
    requireNonEmptyString(entry.device, `${label}.device`);
    requireTrue(entry.registrationVerified, `${label}.registrationVerified`);
    requireTrue(entry.assertionVerified, `${label}.assertionVerified`);
    requireTrue(entry.userVerificationRequired, `${label}.userVerificationRequired`);
    // The security model forbids persisting these; evidence must confirm it.
    requireFalse(entry.persistsRawCredentialId, `${label}.persistsRawCredentialId`);
    requireFalse(entry.persistsAttestationObject, `${label}.persistsAttestationObject`);
    requireNonEmptyString(entry.buildLogReference, `${label}.buildLogReference`);
  }
}

// G-001A: shipped native domain policy matches the pinned RP configuration.
function assertDomainPolicy(policy) {
  requireObject(policy, "domainPolicy");
  const rpId = requireNonEmptyString(policy.rpId, "domainPolicy.rpId");
  requireOriginList(policy.allowedOrigins, "domainPolicy.allowedOrigins");

  requireObject(policy.ios, "domainPolicy.ios");
  if (policy.ios.infoPlistRpId !== rpId) throw new Error("domainPolicy.ios.infoPlistRpId must equal domainPolicy.rpId");
  requireTrue(policy.ios.associatedDomainsVerified, "domainPolicy.ios.associatedDomainsVerified");

  requireObject(policy.android, "domainPolicy.android");
  if (policy.android.mergedManifestRpId !== rpId) {
    throw new Error("domainPolicy.android.mergedManifestRpId must equal domainPolicy.rpId");
  }
  if (!HEX32.test(policy.android.signingCertificateSha256)) {
    throw new Error("domainPolicy.android.signingCertificateSha256 must be a 32-byte hex hash");
  }
  requireTrue(policy.android.assetlinksVerified, "domainPolicy.android.assetlinksVerified");

  requireObject(policy.negativeTests, "domainPolicy.negativeTests");
  requireTrue(policy.negativeTests.mismatchedRpRejected, "domainPolicy.negativeTests.mismatchedRpRejected");
  requireTrue(policy.negativeTests.mismatchedOriginRejected, "domainPolicy.negativeTests.mismatchedOriginRejected");
}

// G-006: verified Helios state reads proven on device with failure modes.
function assertHelios(helios) {
  requireObject(helios, "helios");
  const platforms = requirePlatformArray(helios.platforms, "helios.platforms");
  for (const entry of platforms) {
    const label = `helios.platforms[${entry.platform}]`;
    requireNonEmptyString(entry.network, `${label}.network`);
    requireNonEmptyString(entry.checkpointSource, `${label}.checkpointSource`);
    requireTrue(entry.syncVerified, `${label}.syncVerified`);
    requireTrue(entry.checkpointReviewed, `${label}.checkpointReviewed`);
    requireTrue(entry.wasmRuntimeCompatible, `${label}.wasmRuntimeCompatible`);
    requireTrue(entry.staleCheckpointRejected, `${label}.staleCheckpointRejected`);
    requireTrue(entry.unavailableConsensusHandled, `${label}.unavailableConsensusHandled`);
    requireTrue(entry.malformedProofRejected, `${label}.malformedProofRejected`);
    requireTrue(entry.plainRpcDowngradeLabeledUnverified, `${label}.plainRpcDowngradeLabeledUnverified`);
  }
}

// G-009: hygiene proven on device, respecting the platform asymmetry.
function assertHygiene(hygiene) {
  requireObject(hygiene, "hygiene");

  requireObject(hygiene.android, "hygiene.android");
  requireTrue(hygiene.android.screenshotBlocked, "hygiene.android.screenshotBlocked");
  requireTrue(hygiene.android.recentsThumbnailBlocked, "hygiene.android.recentsThumbnailBlocked");
  requireBoolean(hygiene.android.keystorePersistsAfterReboot, "hygiene.android.keystorePersistsAfterReboot");
  requireBoolean(hygiene.android.keystorePersistsAfterRestore, "hygiene.android.keystorePersistsAfterRestore");
  requirePositiveInteger(hygiene.android.clipboardClearedAfterMs, "hygiene.android.clipboardClearedAfterMs");

  requireObject(hygiene.ios, "hygiene.ios");
  // iOS cannot block screenshots — claiming it did would be dishonest.
  requireFalse(hygiene.ios.screenshotBlocked, "hygiene.ios.screenshotBlocked");
  requireTrue(hygiene.ios.appSwitcherSnapshotCovered, "hygiene.ios.appSwitcherSnapshotCovered");
  requireBoolean(hygiene.ios.keychainPersistsAfterReboot, "hygiene.ios.keychainPersistsAfterReboot");
  requireBoolean(hygiene.ios.keychainPersistsAfterRestore, "hygiene.ios.keychainPersistsAfterRestore");
  requirePositiveInteger(hygiene.ios.clipboardClearedAfterMs, "hygiene.ios.clipboardClearedAfterMs");
}

function requirePlatformArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  for (const entry of value) {
    requireObject(entry, `${label} entry`);
    if (!PLATFORMS.includes(entry.platform)) throw new Error(`${label} entry.platform must be ios or android`);
    if (seen.has(entry.platform)) throw new Error(`${label} has a duplicate ${entry.platform} entry`);
    seen.add(entry.platform);
  }
  for (const platform of PLATFORMS) {
    if (!seen.has(platform)) throw new Error(`${label} must include a ${platform} entry`);
  }
  return value;
}

function requireOriginList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  for (const origin of value) {
    if (typeof origin !== "string" || !/^https:\/\//u.test(origin)) {
      throw new Error(`${label} entries must be https origins`);
    }
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireTrue(value, label) {
  if (value !== true) throw new Error(`${label} must be true`);
}

function requireFalse(value, label) {
  if (value !== false) throw new Error(`${label} must be false`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
