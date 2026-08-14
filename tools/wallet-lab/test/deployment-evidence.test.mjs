import assert from "node:assert/strict";
import test from "node:test";
import { catalogFunctions, compactOpcodeTrace, normalizeCallTrace, summarizeCallTrace } from "../deployment-evidence.mjs";

test("deployment catalog derives canonical selectors and conservative behavior", () => {
  const functions = catalogFunctions("Example", [{
    type: "function",
    name: "configure",
    stateMutability: "nonpayable",
    inputs: [{ name: "items", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "amount", type: "uint256" }] }],
    outputs: []
  }]);

  assert.equal(functions[0].signature, "configure((address,uint256)[])");
  assert.match(functions[0].selector, /^0x[0-9a-f]{8}$/u);
  assert.match(functions[0].behavior, /may change contract state/i);
});

test("opcode evidence is bounded and excludes stack memory and storage payloads", () => {
  const raw = {
    gas: 90_000,
    failed: false,
    returnValue: "0x",
    structLogs: [
      { pc: 1, op: "PUSH1", gas: 90_000, gasCost: 3, depth: 1, stack: ["secret"], memory: ["secret"] },
      { pc: 3, op: "SLOAD", gas: 89_997, gasCost: 100, depth: 1, storage: { secret: "value" } },
      { pc: 4, op: "SSTORE", gas: 89_897, gasCost: 2_900, depth: 1 },
      { pc: 5, op: "RETURN", gas: 86_997, gasCost: 0, depth: 1 }
    ]
  };
  const compact = compactOpcodeTrace(raw, 2);

  assert.equal(compact.totalSteps, 4);
  assert.equal(compact.importantSteps.length, 2);
  assert.equal(compact.truncated, true);
  assert.equal(JSON.stringify(compact).includes("secret"), false);
  assert.deepEqual(compact.opcodeCounts, { PUSH1: 1, SLOAD: 1, SSTORE: 1, RETURN: 1 });
});

test("call trace normalization binds addresses and selectors to catalog functions", () => {
  const catalog = {
    nodes: [{ id: "Target", name: "Target", address: "0x000000000000000000000000000000000000beef", functions: [{ selector: "0x55241077", signature: "setValue(uint256)" }] }]
  };
  const trace = normalizeCallTrace({
    type: "CALL",
    from: "0x0000000000000000000000000000000000000001",
    to: "0x000000000000000000000000000000000000beef",
    input: `0x55241077${"00".repeat(32)}`,
    gasUsed: "0x5208",
    calls: [{ type: "STATICCALL", from: "0x1", to: "0x2", input: "0x", error: "execution reverted" }]
  }, catalog);

  assert.equal(trace.contractId, "Target");
  assert.equal(trace.functionSignature, "setValue(uint256)");
  assert.deepEqual(summarizeCallTrace(trace), { calls: 2, maxDepth: 1, errors: 1, opcodes: { CALL: 1, STATICCALL: 1 } });
});
