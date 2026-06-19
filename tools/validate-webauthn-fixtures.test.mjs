import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateWebAuthnFixtures } from "./validate-webauthn-fixtures.mjs";

const REQUIRED_MUTATIONS = ["challenge", "origin", "rpIdHash", "userVerificationFlag", "signature", "payloadLength"];
const CHALLENGE = "0x" + "11".repeat(32);

test("WebAuthn fixture parser accepts a verified browser assertion shape", async () => {
  await withFixtureRoot(async root => {
    await writeFixture(root, fixture());
    assert.deepEqual(await validateWebAuthnFixtures({ root, requireComplete: true }), {
      fixtureCount: 1,
      incompleteCount: 0
    });
  });
});

test("WebAuthn fixture parser rejects challenge origin rpId flag and low-s mismatches", async () => {
  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ clientChallenge: "0x" + "22".repeat(32) }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /clientData challenge mismatch/);
  });

  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ clientOrigin: "https://evil.example" }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /clientData origin mismatch/);
  });

  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ authenticatorRpId: "evil.example" }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /rpId hash mismatch/);
  });

  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ flags: 0x01 }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /user verification flag missing/);
  });

  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ s: "0x" + "ff".repeat(32) }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /signature s is not low-s/);
  });
});

test("WebAuthn fixture parser rejects duplicate and incomplete verified evidence", async () => {
  await withFixtureRoot(async root => {
    await writeFixture(root, fixture(), "a.json");
    await writeFixture(root, fixture(), "b.json");
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /duplicate fixture matrixId/);
  });

  await withFixtureRoot(async root => {
    await writeFixture(root, fixture({ negativeMutations: REQUIRED_MUTATIONS.slice(0, -1) }));
    await assert.rejects(() => validateWebAuthnFixtures({ root }), /missing negative mutation evidence/);
  });
});

async function withFixtureRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "loom-webauthn-"));
  try {
    await writeFile(join(root, "matrix.json"), JSON.stringify(matrix(), null, 2));
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root, value, name = "fixture.json") {
  await writeFile(join(root, name), JSON.stringify(value, null, 2));
}

function matrix() {
  return {
    version: 1,
    requiredNegativeMutations: REQUIRED_MUTATIONS,
    required: [
      {
        id: "chrome-android-passkey",
        browser: "Chrome",
        authenticator: "Android passkey",
        status: "verified"
      }
    ]
  };
}

function fixture({
  clientChallenge = CHALLENGE,
  clientOrigin = "https://wallet.example",
  authenticatorRpId = "wallet.example",
  flags = 0x05,
  s = "0x" + "01".padStart(64, "0"),
  negativeMutations = REQUIRED_MUTATIONS
} = {}) {
  const rpId = "wallet.example";
  return {
    version: 1,
    matrixId: "chrome-android-passkey",
    capturedAt: "2026-06-19",
    platform: "Android",
    browser: "Chrome",
    authenticator: "Android passkey",
    authenticatorClass: "platform",
    rpId,
    origin: "https://wallet.example",
    publicKeyX: "0x" + "01".repeat(32),
    publicKeyY: "0x" + "02".repeat(32),
    credentialIdHash: "0x" + "03".repeat(32),
    challenge: CHALLENGE,
    authenticatorData: authenticatorData(authenticatorRpId, flags),
    clientDataJSON: JSON.stringify({
      type: "webauthn.get",
      challenge: base64Url(clientChallenge),
      origin: clientOrigin,
      crossOrigin: false
    }),
    r: "0x" + "04".repeat(32),
    s,
    expected: true,
    negativeMutations
  };
}

function authenticatorData(rpId, flags) {
  const rpIdHash = createHash("sha256").update(rpId).digest("hex");
  return `0x${rpIdHash}${flags.toString(16).padStart(2, "0")}00000001`;
}

function base64Url(hex) {
  return Buffer.from(hex.slice(2), "hex")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
