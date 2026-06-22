import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_MUTATIONS = Object.freeze([
  "challenge",
  "origin",
  "rpIdHash",
  "userVerificationFlag",
  "signature",
  "payloadLength"
]);

export function buildNegativeCaseManifest(fixture) {
  assertFixtureShape(fixture);
  const manifest = {
    version: 1,
    fixtureMatrixId: fixture.matrixId,
    fixtureChallenge: fixture.challenge,
    fixtureCredentialIdHash: fixture.credentialIdHash,
    fixturePublicKeyHash: hashJson({
      publicKeyX: fixture.publicKeyX,
      publicKeyY: fixture.publicKeyY
    }),
    mutations: REQUIRED_MUTATIONS.map(name => mutationCase(name, fixture))
  };
  return Object.freeze({
    ...manifest,
    manifestHash: hashJson(manifest)
  });
}

function mutationCase(name, fixture) {
  const base = {
    name,
    expected: false,
    fixtureMatrixId: fixture.matrixId
  };
  switch (name) {
    case "challenge":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["clientDataJSON.challenge"]),
        reason: "challenge must match the account-bound signed challenge"
      });
    case "origin":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["clientDataJSON.origin"]),
        reason: "origin must match the configured relying-party origin"
      });
    case "rpIdHash":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["authenticatorData.rpIdHash"]),
        reason: "rpId hash must match the expected relying-party id"
      });
    case "userVerificationFlag":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["authenticatorData.flags.uv"]),
        reason: "user verification must be present"
      });
    case "signature":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["signature.r", "signature.s"]),
        reason: "signature must verify over authenticatorData and clientDataHash"
      });
    case "payloadLength":
      return Object.freeze({
        ...base,
        mutates: Object.freeze(["authenticatorData.length", "clientDataJSON.length"]),
        reason: "malformed payload lengths must fail closed"
      });
    default:
      throw new Error(`unsupported WebAuthn mutation: ${name}`);
  }
}

function assertFixtureShape(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("fixture must be an object");
  }
  for (const key of ["matrixId", "challenge", "credentialIdHash", "publicKeyX", "publicKeyY"]) {
    if (typeof fixture[key] !== "string" || fixture[key].length === 0) {
      throw new Error(`fixture.${key} is required`);
    }
  }
  for (const key of ["challenge", "credentialIdHash", "publicKeyX", "publicKeyY"]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fixture[key])) throw new Error(`fixture.${key} must be bytes32`);
  }
}

function hashJson(value) {
  return `0x${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item)
      .sort()
      .reduce((acc, key) => {
        acc[key] = item[key];
        return acc;
      }, {});
  });
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("usage: node tools/webauthn-fixture/negative-cases.mjs <fixture.json>");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  console.log(JSON.stringify(buildNegativeCaseManifest(fixture), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
