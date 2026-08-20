import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters } from "viem";
import {
  broadcastLocalDeploymentCall,
  inspectDeploymentTransaction,
  normalizeStateDiff,
  prepareDeploymentCall,
  simulateDeploymentCall
} from "../execution-engine.mjs";

const contract = {
  id: "Example",
  name: "Example",
  address: "0x0000000000000000000000000000000000000010",
  functions: [
    { name: "readValue", signature: "readValue(uint256)", selector: "0x0f2c9329", stateMutability: "view", inputs: [{ name: "offset", type: "uint256" }], outputs: [{ name: "value", type: "uint256" }] },
    { name: "setValue", signature: "setValue(uint256)", selector: "0x55241077", stateMutability: "nonpayable", inputs: [{ name: "value", type: "uint256" }], outputs: [] }
  ],
  events: [],
  errors: [{ name: "Unauthorized", selector: "0x82b42900", inputs: [] }]
};
const deployment = { nodes: [contract], edges: [] };

test("execution preparation is deployment-scoped and encodes exact ABI inputs", () => {
  const prepared = prepareDeploymentCall({ deployment, chainId: 31337, contractId: "Example", selector: "0x55241077", args: ["42"], valueWei: "0" });
  assert.equal(prepared.transaction.to, contract.address);
  assert.equal(prepared.transaction.data, "0x55241077000000000000000000000000000000000000000000000000000000000000002a");
  assert.equal(prepared.transaction.value, "0x0");
  assert.throws(() => prepareDeploymentCall({ deployment, chainId: 31337, contractId: "Unknown", selector: "0x55241077", args: ["42"] }), /not part of this deployment/u);
  assert.throws(() => prepareDeploymentCall({ deployment, chainId: 31337, contractId: "Example", selector: "0x55241077", args: ["42"], valueWei: "1" }), /non-payable/u);
});

test("simulation correlates decoded output, call trace, opcode evidence, and bounded state diff", async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_call") return encodeAbiParameters([{ type: "uint256" }], [42n]);
    if (params[2]?.tracer === "callTracer") return { type: "STATICCALL", from: "0x0000000000000000000000000000000000000001", to: contract.address, input: "0x0f2c9329", output: encodeAbiParameters([{ type: "uint256" }], [42n]) };
    if (params[2]?.tracer === "prestateTracer") return { pre: { [contract.address]: { storage: { "0x01": "0x00" } } }, post: { [contract.address]: { storage: { "0x01": "0x2a" } } } };
    return { gas: 1000, failed: false, returnValue: "", structLogs: [{ pc: 1, op: "SLOAD", depth: 1, gas: 900, gasCost: 100 }] };
  };
  const result = await simulateDeploymentCall({ rpc, deployment, chainId: 31337, contractId: "Example", selector: "0x0f2c9329", args: ["0"], valueWei: "0" });
  assert.equal(result.status, "success");
  assert.equal(result.output.decoded, "42");
  assert.equal(result.trace.contractId, "Example");
  assert.equal(result.opcodeProfile.opcodeCounts.SLOAD, 1);
  assert.equal(result.stateDiff.accounts[0].storage[0].after, "0x2a");
  assert.deepEqual(result.capabilities, { callTrace: "available", opcodeTrace: "available", stateDiff: "available" });
  assert.equal(calls.filter(([method]) => method === "debug_traceCall").length, 3);
});

test("local broadcast fails closed when preflight reverts", async () => {
  let broadcasts = 0;
  const rpc = async method => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { data: "0x82b42900" });
    if (method === "eth_sendTransaction") { broadcasts += 1; return `0x${"11".repeat(32)}`; }
    throw new Error("trace unavailable");
  };
  const result = await broadcastLocalDeploymentCall({ rpc, deployment, chainId: 31337, sender: "0x0000000000000000000000000000000000000001", contractId: "Example", selector: "0x55241077", args: ["42"], valueWei: "0" });
  assert.equal(result.kind, "local-preflight");
  assert.equal(result.status, "reverted");
  assert.equal(result.revert.name, "Unauthorized");
  assert.equal(result.broadcast, "blocked");
  assert.equal(broadcasts, 0);
});

test("transaction inspection rejects evidence from a different chain before accepting a receipt", async () => {
  const methods = [];
  const rpc = async method => {
    methods.push(method);
    if (method === "eth_chainId") return "0xaa36a7";
    throw new Error("transaction evidence must not be queried after a chain mismatch");
  };
  await assert.rejects(
    inspectDeploymentTransaction({
      rpc,
      deployment,
      chainId: 31337,
      contractId: "Example",
      selector: "0x55241077",
      transactionHash: `0x${"11".repeat(32)}`
    }),
    /chain does not match/u
  );
  assert.deepEqual(methods, ["eth_chainId"]);
});

test("state diff output is bounded", () => {
  const pre = {};
  const post = {};
  for (let index = 0; index < 80; index += 1) {
    const address = `0x${index.toString(16).padStart(40, "0")}`;
    pre[address] = { nonce: "0x0" };
    post[address] = { nonce: "0x1" };
  }
  const result = normalizeStateDiff({ pre, post });
  assert.equal(result.accounts.length, 64);
  assert.equal(result.truncated, true);
});
