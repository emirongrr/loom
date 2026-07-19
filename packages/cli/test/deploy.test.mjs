import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";
import { diffManifests, inspectManifest, validateManifest, verifyDeployment } from "../src/deploy.mjs";

// A byte string and the code hash the on-chain verifier computes from it, so a
// fake rpc returning this code makes verifyManifestOnChain pass.
const CODE = "0x60fe6001";
const HASH = keccak256(CODE);
const OTHER = `0x${"11".repeat(32)}`;

const A = {
  entryPoint: "0x433709e09c7750b04c222fb46e0f27642f41f0b7",
  factory: "0x610178da211fef7d417bc0e6fed39f05609ad788",
  implementation: "0x2222222222222222222222222222222222222222",
  validator: "0x3333333333333333333333333333333333333333"
};

function canonicalManifest(over = {}) {
  return {
    schemaVersion: "1",
    releaseChannel: "devnet",
    chainId: 31337,
    entryPoint: { address: A.entryPoint, runtimeCodeHash: HASH },
    factory: { address: A.factory, runtimeCodeHash: HASH },
    account: {
      implementation: { address: A.implementation, runtimeCodeHash: HASH },
      proxy: { creationCodeHash: OTHER, runtimeCodeHash: OTHER }
    },
    modules: [{ type: "validator", address: A.validator, runtimeCodeHash: HASH, version: "1.0.0", status: "stable" }],
    compatibility: { contractRelease: "1.0.0", sdkRange: "^0.1" },
    ...over
  };
}

// A fake chain where every manifest address carries the matching code, unless
// listed in `broken` (which returns different code, failing the hash check).
function fakeRpc({ broken = new Set() } = {}) {
  return async (method, params) => {
    if (method === "eth_getCode") return broken.has(params[0].toLowerCase()) ? "0xdead" : CODE;
    return null;
  };
}

test("manifest validate accepts a schema-valid manifest and computes its hash", async () => {
  const report = await validateManifest(canonicalManifest());
  assert.equal(report.schemaValid, true);
  assert.match(report.manifestHash, /^0x[0-9a-f]{64}$/);
  assert.equal(report.chainId, 31337);
  assert.equal(report.onChain, null, "no network without an rpc");
});

test("manifest validate rejects a schema-invalid manifest with exit 6", async () => {
  await assert.rejects(
    validateManifest({ schemaVersion: "1", chainId: 31337 }),
    e => e.exitCode === 6 && /manifest is invalid/.test(e.message)
  );
});

test("manifest validate confirms code hashes on chain when an rpc is supplied", async () => {
  const report = await validateManifest(canonicalManifest(), { rpc: fakeRpc() });
  assert.equal(report.onChain.ok, true);

  await assert.rejects(
    validateManifest(canonicalManifest(), { rpc: fakeRpc({ broken: new Set([A.factory]) }) }),
    e => e.exitCode === 6 && /on-chain verification failed/.test(e.message)
  );
});

test("deploy verify fails (exit 6) on a code-hash mismatch and lists the check", async () => {
  const ok = await verifyDeployment(canonicalManifest(), fakeRpc());
  assert.equal(ok.ok, true);
  assert.ok(ok.checks.every(c => c.ok));

  await assert.rejects(
    verifyDeployment(canonicalManifest(), fakeRpc({ broken: new Set([A.entryPoint]) })),
    e => e.exitCode === 6 && /deployment verification failed/.test(e.message)
  );
});

test("deploy inspect labels contracts asserted without an rpc, verified with one", async () => {
  const asserted = await inspectManifest(canonicalManifest());
  assert.equal(asserted.entryPoint.state, "asserted");
  assert.equal(asserted.modules[0].state, "asserted");

  const verified = await inspectManifest(canonicalManifest(), { rpc: fakeRpc({ broken: new Set([A.validator]) }) });
  assert.equal(verified.entryPoint.state, "verified");
  assert.equal(verified.factory.state, "verified");
  assert.equal(verified.modules[0].state, "unverified", "the broken module is not verified");
});

test("manifest diff flags authority-affecting changes as breaking", () => {
  // An EntryPoint address change is breaking.
  const d1 = diffManifests(canonicalManifest(), canonicalManifest({ entryPoint: { address: "0x9999999999999999999999999999999999999999", runtimeCodeHash: HASH } }));
  assert.equal(d1.compatible, false);
  assert.ok(d1.changes.some(c => c.field === "entryPoint.address" && c.severity === "breaking"));

  // A validator code-hash change is breaking.
  const d2 = diffManifests(canonicalManifest(), canonicalManifest({ modules: [{ type: "validator", address: A.validator, runtimeCodeHash: OTHER, version: "1.0.0", status: "stable" }] }));
  assert.equal(d2.compatible, false);
  assert.ok(d2.changes.some(c => c.field === "module.validator.runtimeCodeHash"));

  // A chain-id change is incompatible.
  const d3 = diffManifests(canonicalManifest(), canonicalManifest({ chainId: 1 }));
  assert.equal(d3.compatible, false);
  assert.ok(d3.changes.some(c => c.field === "chainId" && c.severity === "incompatible"));
});

test("manifest diff reports compatible when nothing authority-affecting changed", () => {
  // Only the release channel differs -> notable, not breaking.
  const d = diffManifests(canonicalManifest(), canonicalManifest({ releaseChannel: "testnet" }));
  assert.equal(d.compatible, true);
  assert.deepEqual(d.changes.map(c => c.field), ["releaseChannel"]);
});
