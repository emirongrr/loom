import assert from "node:assert/strict";
import test from "node:test";

import { materializeImmutableRuntime, materializeInitCode } from "./materialize-immutable-runtime.mjs";

test("ABI-encodes constructor arguments into exact deployment init code", () => {
  const initCode = materializeInitCode({
    abi: [{ type: "constructor", inputs: [{ name: "owner", type: "address" }], stateMutability: "nonpayable" }],
    bytecode: { object: "0x6001" }
  }, [`0x${"11".repeat(20)}`], "deployment");
  assert.equal(initCode, `0x6001${"00".repeat(12)}${"11".repeat(20)}`);
});

test("rejects constructor arguments that do not match the artifact ABI", () => {
  assert.throws(
    () => materializeInitCode({ abi: [], bytecode: { object: "0x6001" } }, [1], "deployment"),
    /do not encode against the artifact ABI/u
  );
});

const artifact = {
  deployedBytecode: {
    object: `0x${"00".repeat(80)}`,
    immutableReferences: {
      17: [{ start: 8, length: 32 }],
      23: [{ start: 48, length: 20 }]
    }
  }
};

test("fills every immutable reference before hashing deployment runtime", () => {
  const addressWord = `0x${"00".repeat(12)}${"22".repeat(20)}`;
  const runtime = materializeImmutableRuntime(artifact, {
    17: `0x${"11".repeat(32)}`,
    23: addressWord
  }, "deployment");
  assert.equal(runtime.slice(2 + 8 * 2, 2 + 40 * 2), "11".repeat(32));
  assert.equal(runtime.slice(2 + 48 * 2, 2 + 68 * 2), "22".repeat(20));
});

test("immutable runtime evidence rejects missing, unknown, and malformed words", () => {
  assert.throws(() => materializeImmutableRuntime(artifact, undefined, "deployment"), /immutableValues is required/);
  assert.throws(() => materializeImmutableRuntime(artifact, { 17: `0x${"11".repeat(32)}` }, "deployment"), /\[23\]/);
  assert.throws(() => materializeImmutableRuntime(artifact, {
    17: `0x${"11".repeat(32)}`, 23: `0x${"22".repeat(32)}`, 99: `0x${"33".repeat(32)}`
  }, "deployment"), /unknown immutable id 99/);
});

test("immutable runtime evidence rejects out-of-bounds and overlapping slots", () => {
  const outside = {
    deployedBytecode: {
      object: "0x0000",
      immutableReferences: { 1: [{ start: 1, length: 2 }] }
    }
  };
  assert.throws(
    () => materializeImmutableRuntime(outside, { 1: `0x${"11".repeat(32)}` }, "deployment"),
    /outside runtime bytecode/u
  );

  const overlapping = {
    deployedBytecode: {
      object: "0x00000000",
      immutableReferences: {
        1: [{ start: 0, length: 2 }],
        2: [{ start: 1, length: 2 }]
      }
    }
  };
  assert.throws(
    () => materializeImmutableRuntime(overlapping, {
      1: `0x${"11".repeat(32)}`,
      2: `0x${"22".repeat(32)}`
    }, "deployment"),
    /overlapping immutable references/u
  );
});
