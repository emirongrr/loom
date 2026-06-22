import assert from "node:assert/strict";
import test from "node:test";
import { buildNegativeCaseManifest } from "./webauthn-fixture/negative-cases.mjs";

const fixture = Object.freeze({
  matrixId: "chrome-android-passkey",
  challenge: "0x" + "11".repeat(32),
  credentialIdHash: "0x" + "22".repeat(32),
  publicKeyX: "0x" + "33".repeat(32),
  publicKeyY: "0x" + "44".repeat(32)
});

test("WebAuthn negative-case manifest binds every required mutation", () => {
  const manifest = buildNegativeCaseManifest(fixture);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.fixtureMatrixId, fixture.matrixId);
  assert.equal(manifest.fixtureChallenge, fixture.challenge);
  assert.match(manifest.fixturePublicKeyHash, /^0x[0-9a-f]{64}$/);
  assert.match(manifest.manifestHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(
    manifest.mutations.map(item => item.name),
    ["challenge", "origin", "rpIdHash", "userVerificationFlag", "signature", "payloadLength"]
  );
  assert.equal(manifest.mutations.every(item => item.expected === false), true);
  assert.equal(manifest.mutations.every(item => item.mutates.length > 0), true);
});

test("WebAuthn negative-case manifest is deterministic and rejects malformed fixture identity", () => {
  assert.deepEqual(buildNegativeCaseManifest(fixture), buildNegativeCaseManifest({ ...fixture }));
  assert.throws(
    () => buildNegativeCaseManifest({ ...fixture, challenge: "0x1234" }),
    /fixture.challenge must be bytes32/
  );
  assert.throws(
    () => buildNegativeCaseManifest({ ...fixture, matrixId: "" }),
    /fixture.matrixId is required/
  );
});
