// Generates the differential fixture that pins @loom/core's signature-envelope
// encoding against the on-chain decoders.
//
// @loom/core encodes the account-level `(validator, validatorSignature)`
// envelope and the `WebAuthnSignature` struct off-chain; this fixture is the
// shared oracle for two checks:
//   - test/integration/SignatureEnvelopeDifferential.t.sol decodes the encoded
//     envelope with the same abi.decode calls LoomAccount and P256Validator
//     perform and asserts every field round-trips — so the fixture stays honest
//     to the contracts.
//   - tools/sdk/generate-signature-envelope-fixture.test.mjs re-runs this
//     generator and asserts the committed fixture is current — so it stays
//     honest to @loom/core.
//
// Run `npm run sdk:signature:generate` after an intentional encoding change and
// commit the regenerated fixture.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeValidatorSignature, encodeWebAuthnSignature, parseP256Signature } from "../../packages/core/dist/index.js";

// Fixed inputs exercising the encoding: dynamic fields of different lengths and
// a raw high-s signature that must normalize to low-s before encoding.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const inputs = {
  validator: "0x3333333333333333333333333333333333333333",
  authenticatorData: `0x${"aa".repeat(37)}`,
  clientDataJSON: `0x${"bb".repeat(64)}`,
  origin: "https://wallet.example",
  rawSignature: `0x${(5n).toString(16).padStart(64, "0")}${(P256_N - 7n).toString(16).padStart(64, "0")}`
};

export function buildFixture() {
  const { r, s } = parseP256Signature(inputs.rawSignature);
  const webAuthnSignature = encodeWebAuthnSignature({
    authenticatorData: inputs.authenticatorData,
    clientDataJSON: inputs.clientDataJSON,
    origin: inputs.origin,
    r,
    s
  });
  return {
    inputs,
    outputs: {
      r,
      s,
      webAuthnSignature,
      envelope: encodeValidatorSignature(inputs.validator, webAuthnSignature)
    }
  };
}

const fixturePath = fileURLToPath(new URL("../../test/fixtures/signature-envelope.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(fixturePath, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${fixturePath}`);
}
