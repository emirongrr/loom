import assert from "node:assert/strict";
import test from "node:test";
import { LoomError, createDeploymentProfile, manifestHash, parseDeploymentManifest } from "../dist/index.js";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const HASH_C = `0x${"33".repeat(32)}`;

function validManifest() {
  return {
    schemaVersion: "1",
    releaseChannel: "testnet",
    chainId: 11155111,
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", runtimeCodeHash: HASH_A },
    factory: { address: "0x1111111111111111111111111111111111111111", runtimeCodeHash: HASH_B },
    account: {
      implementation: { address: "0x2222222222222222222222222222222222222222", runtimeCodeHash: HASH_C },
      proxy: { creationCodeHash: HASH_A, runtimeCodeHash: HASH_B }
    },
    modules: [
      {
        type: "validator",
        address: "0x3333333333333333333333333333333333333333",
        runtimeCodeHash: HASH_C,
        version: "1.0.0",
        status: "stable"
      }
    ],
    compatibility: { contractRelease: "0.1.0", sdkRange: "^0.1.0" }
  };
}

test("a well-formed manifest parses", () => {
  const manifest = parseDeploymentManifest(validManifest());
  assert.equal(manifest.chainId, 11155111);
  assert.equal(manifest.modules[0].type, "validator");
});

test("unknown fields are rejected", () => {
  const manifest = { ...validManifest(), surprise: true };
  assert.throws(() => parseDeploymentManifest(manifest), LoomError);
});

test("malformed address and code hash are rejected", () => {
  const badAddress = validManifest();
  badAddress.factory.address = "0xnope";
  assert.throws(() => parseDeploymentManifest(badAddress), LoomError);

  const badHash = validManifest();
  badHash.entryPoint.runtimeCodeHash = "0x1234";
  assert.throws(() => parseDeploymentManifest(badHash), LoomError);
});

test("wrong schema version is rejected", () => {
  const manifest = { ...validManifest(), schemaVersion: "2" };
  assert.throws(() => parseDeploymentManifest(manifest), LoomError);
});

test("manifestHash is deterministic and key-order independent", () => {
  const a = parseDeploymentManifest(validManifest());
  const reordered = validManifest();
  const rebuilt = { compatibility: reordered.compatibility, modules: reordered.modules, ...reordered };
  const b = parseDeploymentManifest(rebuilt);
  assert.match(manifestHash(a), /^0x[0-9a-f]{64}$/);
  assert.equal(manifestHash(a), manifestHash(b));
});

test("manifestHash changes when a code hash changes", () => {
  const a = parseDeploymentManifest(validManifest());
  const mutated = validManifest();
  mutated.entryPoint.runtimeCodeHash = HASH_B;
  assert.notEqual(manifestHash(a), manifestHash(parseDeploymentManifest(mutated)));
});

test("a profile is bound to its source manifest hash and can filter modules", () => {
  const manifest = parseDeploymentManifest(validManifest());
  const full = createDeploymentProfile(manifest);
  assert.equal(full.sourceManifestHash, manifestHash(manifest));
  assert.equal(full.entryPoint, manifest.entryPoint.address);
  assert.equal(full.modules.length, 1);

  const empty = createDeploymentProfile(manifest, { modules: ["0x9999999999999999999999999999999999999999"] });
  assert.equal(empty.modules.length, 0);
});
