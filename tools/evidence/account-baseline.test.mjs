import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EIP170_RUNTIME_LIMIT,
  REQUIRED_RELEASE_MARGIN,
  TARGET_RELEASE_MARGIN,
  assessRuntimeSize,
  baselineDifferences,
  hexByteLength
} from "./account-baseline.mjs";

const evidencePath = fileURLToPath(
  new URL("../../evidence/baselines/account-phase0.json", import.meta.url)
);

test("hex byte length rejects malformed compiler output", () => {
  assert.equal(hexByteLength("0x"), 0);
  assert.equal(hexByteLength("0x0011ff"), 3);
  assert.throws(() => hexByteLength("0011"), /0x-prefixed/u);
  assert.throws(() => hexByteLength("0x0"), /even-length/u);
  assert.throws(() => hexByteLength("0xzz"), /hex value/u);
});

test("runtime policy separates deployability, required margin, and target margin", () => {
  const atLimit = assessRuntimeSize(EIP170_RUNTIME_LIMIT);
  assert.equal(atLimit.deployable, true);
  assert.equal(atLimit.releaseReady, false);
  assert.equal(atLimit.targetReached, false);

  const required = assessRuntimeSize(EIP170_RUNTIME_LIMIT - REQUIRED_RELEASE_MARGIN);
  assert.equal(required.releaseReady, true);
  assert.equal(required.targetReached, false);

  const target = assessRuntimeSize(EIP170_RUNTIME_LIMIT - TARGET_RELEASE_MARGIN);
  assert.equal(target.releaseReady, true);
  assert.equal(target.targetReached, true);

  assert.equal(assessRuntimeSize(EIP170_RUNTIME_LIMIT + 1).deployable, false);
});

test("baseline comparison ignores the descriptive base revision but pins build inputs", () => {
  const base = {
    target: "A:A",
    source: { baselineRevision: "one", sourceTree: "tree", packageLockSha256: "lock", submodules: ["sub"] },
    compiler: { solidity: "0.8.36" },
    bytecode: { runtime: { bytes: 1 } },
    compatibility: { abiEntries: 2 }
  };
  const sameBuild = structuredClone(base);
  sameBuild.source.baselineRevision = "two";
  assert.deepEqual(baselineDifferences(base, sameBuild), []);

  sameBuild.compiler.solidity = "0.8.37";
  assert.match(baselineDifferences(base, sameBuild)[0], /compiler changed/u);
});

test("committed evidence is internally consistent with the release policy", () => {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const measured = assessRuntimeSize(evidence.bytecode.runtime.bytes);

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.bytecode.runtime.runtimeBytes, measured.runtimeBytes);
  assert.equal(evidence.bytecode.runtime.marginBytes, measured.marginBytes);
  assert.equal(evidence.bytecode.runtime.releaseReady, measured.releaseReady);
  assert.equal(evidence.bytecode.runtime.targetReached, measured.targetReached);
  assert.match(evidence.bytecode.runtime.keccak256, /^0x[0-9a-f]{64}$/u);
  assert.match(evidence.bytecode.initCode.keccak256, /^0x[0-9a-f]{64}$/u);
});
