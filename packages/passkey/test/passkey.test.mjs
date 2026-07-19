import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  base64UrlEncode,
  createWebAuthnSigner,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  encodeWebAuthnValidatorSignature,
  parseP256Signature,
  passkeyChallenge
} from "../dist/index.js";

const validator = "0x3333333333333333333333333333333333333333";
const origin = "https://wallet.example";
const hash = `0x${"ab".repeat(32)}`;

// A software P-256 assertion, the shape a platform authenticator returns.
function makeAssertion() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const authenticatorData = Buffer.concat([crypto.randomBytes(32), Buffer.from([0x05])]);
  const clientDataJSON = Buffer.from(`{"type":"webauthn.get","challenge":"${passkeyChallenge(hash)}","origin":"${origin}","crossOrigin":false}`, "utf8");
  const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  const signature = crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return {
    authenticatorData: `0x${authenticatorData.toString("hex")}`,
    clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
    signature: `0x${signature.toString("hex")}`
  };
}

test("passkeyChallenge is the base64url of the user-operation hash", () => {
  assert.equal(passkeyChallenge(hash), base64UrlEncode(hash));
});

test("encodeWebAuthnValidatorSignature composes the exact account envelope", () => {
  const assertion = makeAssertion();
  const { r, s } = parseP256Signature(assertion.signature);
  const expected = encodeValidatorSignature(
    validator,
    encodeWebAuthnSignature({
      authenticatorData: assertion.authenticatorData,
      clientDataJSON: assertion.clientDataJSON,
      origin,
      r,
      s
    })
  );
  assert.equal(encodeWebAuthnValidatorSignature({ validator, origin, assertion }), expected);
});

test("createWebAuthnSigner signs a hash into a validator envelope, engine-free", async () => {
  const assertion = makeAssertion();
  let sawChallenge = null;
  const signer = createWebAuthnSigner({
    validator,
    origin,
    rpId: "wallet.example",
    signChallenge: challenge => {
      sawChallenge = challenge;
      return assertion;
    }
  });

  const envelope = signer.sign(hash);
  const resolved = await envelope;
  // The provider was asked to sign the base64url challenge for this exact hash.
  assert.equal(sawChallenge.challenge, base64UrlEncode(hash));
  assert.equal(sawChallenge.userOperationHash, hash);
  assert.equal(sawChallenge.origin, origin);
  // The result is exactly the encoding of that assertion.
  assert.equal(resolved, encodeWebAuthnValidatorSignature({ validator, origin, assertion }));

  // A signature-shaped dummy and the verification-gas margin are exposed for
  // gas estimation before a real assertion exists.
  assert.match(signer.dummySignature, /^0x[0-9a-f]+$/);
  assert.equal(signer.verificationGasBuffer, 400_000n);
  assert.equal(signer.validator, validator);
});

test("createWebAuthnSigner validates its inputs", () => {
  assert.throws(() => createWebAuthnSigner({ validator, origin }), /requires a signChallenge/);
  assert.throws(() => createWebAuthnSigner({ validator, signChallenge: () => ({}) }), /requires an origin/);
});

test("the dummy signature has the same shape as a real one (both decode as an envelope)", () => {
  const signer = createWebAuthnSigner({ validator, origin, signChallenge: () => makeAssertion() });
  const real = encodeWebAuthnValidatorSignature({ validator, origin, assertion: makeAssertion() });
  // Both are (address, bytes) envelopes for the same validator.
  assert.ok(signer.dummySignature.includes(validator.slice(2).toLowerCase()));
  assert.ok(real.includes(validator.slice(2).toLowerCase()));
});
