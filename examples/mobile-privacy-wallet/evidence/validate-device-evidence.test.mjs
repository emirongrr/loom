import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateDeviceEvidence } from "./validate-device-evidence.mjs";

// A fully completed, honest evidence bundle — the shape a real device session
// must produce. The tests mutate copies of this to prove each guard.
function completeEvidence() {
  const passkeyPlatform = platform => ({
    platform,
    osVersion: platform === "ios" ? "iOS 18.2" : "Android 15",
    device: platform === "ios" ? "iPhone 15" : "Pixel 8",
    registrationVerified: true,
    assertionVerified: true,
    userVerificationRequired: true,
    persistsRawCredentialId: false,
    persistsAttestationObject: false,
    buildLogReference: `artifacts/${platform}-release-build.log`
  });
  const heliosPlatform = platform => ({
    platform,
    network: "sepolia",
    checkpointSource: "reviewed weak-subjectivity checkpoint from beaconstate.info",
    syncVerified: true,
    checkpointReviewed: true,
    wasmRuntimeCompatible: true,
    staleCheckpointRejected: true,
    unavailableConsensusHandled: true,
    malformedProofRejected: true,
    plainRpcDowngradeLabeledUnverified: true
  });
  return {
    version: 1,
    app: { bundleIdentifier: "org.loom.mobileprivacywallet", buildType: "release" },
    passkey: { platforms: [passkeyPlatform("ios"), passkeyPlatform("android")] },
    domainPolicy: {
      rpId: "wallet.example.org",
      allowedOrigins: ["https://wallet.example.org"],
      ios: { infoPlistRpId: "wallet.example.org", associatedDomainsVerified: true },
      android: {
        mergedManifestRpId: "wallet.example.org",
        signingCertificateSha256: `0x${"ab".repeat(32)}`,
        assetlinksVerified: true
      },
      negativeTests: { mismatchedRpRejected: true, mismatchedOriginRejected: true }
    },
    helios: { platforms: [heliosPlatform("ios"), heliosPlatform("android")] },
    hygiene: {
      android: {
        screenshotBlocked: true,
        recentsThumbnailBlocked: true,
        keystorePersistsAfterReboot: true,
        keystorePersistsAfterRestore: false,
        clipboardClearedAfterMs: 60000
      },
      ios: {
        screenshotBlocked: false,
        appSwitcherSnapshotCovered: true,
        keychainPersistsAfterReboot: true,
        keychainPersistsAfterRestore: false,
        clipboardClearedAfterMs: 60000
      }
    }
  };
}

test("a complete, honest device evidence bundle validates", () => {
  validateDeviceEvidence(completeEvidence());
});

test("the committed template is intentionally incomplete and must not validate", async () => {
  const templatePath = fileURLToPath(new URL("./device-evidence.template.json", import.meta.url));
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  assert.throws(() => validateDeviceEvidence(template), /must be true|must be a non-empty string|PENDING|32-byte/);
});

test("passkey evidence must cover both platforms and never persist secrets (G-001)", () => {
  const missingAndroid = completeEvidence();
  missingAndroid.passkey.platforms = [missingAndroid.passkey.platforms[0]];
  assert.throws(() => validateDeviceEvidence(missingAndroid), /must include a android entry/);

  const persistsId = completeEvidence();
  persistsId.passkey.platforms[0].persistsRawCredentialId = true;
  assert.throws(() => validateDeviceEvidence(persistsId), /persistsRawCredentialId must be false/);

  const persistsAttestation = completeEvidence();
  persistsAttestation.passkey.platforms[1].persistsAttestationObject = true;
  assert.throws(() => validateDeviceEvidence(persistsAttestation), /persistsAttestationObject must be false/);

  const noUv = completeEvidence();
  noUv.passkey.platforms[0].userVerificationRequired = false;
  assert.throws(() => validateDeviceEvidence(noUv), /userVerificationRequired must be true/);
});

test("domain policy must match the pinned RP across native builds (G-001A)", () => {
  const iosMismatch = completeEvidence();
  iosMismatch.domainPolicy.ios.infoPlistRpId = "attacker.example";
  assert.throws(() => validateDeviceEvidence(iosMismatch), /infoPlistRpId must equal/);

  const androidMismatch = completeEvidence();
  androidMismatch.domainPolicy.android.mergedManifestRpId = "attacker.example";
  assert.throws(() => validateDeviceEvidence(androidMismatch), /mergedManifestRpId must equal/);

  const badCert = completeEvidence();
  badCert.domainPolicy.android.signingCertificateSha256 = "0x1234";
  assert.throws(() => validateDeviceEvidence(badCert), /signingCertificateSha256 must be a 32-byte hex/);

  const httpOrigin = completeEvidence();
  httpOrigin.domainPolicy.allowedOrigins = ["http://wallet.example.org"];
  assert.throws(() => validateDeviceEvidence(httpOrigin), /must be https origins/);

  const noNegative = completeEvidence();
  noNegative.domainPolicy.negativeTests.mismatchedRpRejected = false;
  assert.throws(() => validateDeviceEvidence(noNegative), /mismatchedRpRejected must be true/);
});

test("Helios evidence must record sync and every failure mode on both platforms (G-006)", () => {
  const noStale = completeEvidence();
  noStale.helios.platforms[0].staleCheckpointRejected = false;
  assert.throws(() => validateDeviceEvidence(noStale), /staleCheckpointRejected must be true/);

  const noReview = completeEvidence();
  noReview.helios.platforms[1].checkpointReviewed = false;
  assert.throws(() => validateDeviceEvidence(noReview), /checkpointReviewed must be true/);
});

test("hygiene evidence enforces the platform asymmetry — iOS cannot claim screenshot blocking (G-009)", () => {
  const iosOverclaim = completeEvidence();
  iosOverclaim.hygiene.ios.screenshotBlocked = true;
  assert.throws(() => validateDeviceEvidence(iosOverclaim), /hygiene\.ios\.screenshotBlocked must be false/);

  const androidWeak = completeEvidence();
  androidWeak.hygiene.android.screenshotBlocked = false;
  assert.throws(() => validateDeviceEvidence(androidWeak), /hygiene\.android\.screenshotBlocked must be true/);

  const noSnapshot = completeEvidence();
  noSnapshot.hygiene.ios.appSwitcherSnapshotCovered = false;
  assert.throws(() => validateDeviceEvidence(noSnapshot), /appSwitcherSnapshotCovered must be true/);

  const badTtl = completeEvidence();
  badTtl.hygiene.android.clipboardClearedAfterMs = 0;
  assert.throws(() => validateDeviceEvidence(badTtl), /clipboardClearedAfterMs must be a positive integer/);
});
