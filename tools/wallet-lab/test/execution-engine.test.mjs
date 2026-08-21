import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import {
  analyzeDeploymentTransaction,
  broadcastLocalDeploymentCall,
  materializeLoomProxyRuntime,
  inspectDeploymentTransaction,
  normalizeStateDiff,
  prepareDeploymentCall,
  probeDeploymentFunctions,
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
  const rpc = async (method, params) => {
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

test("transaction analysis identifies Loom behind an EntryPoint transaction without a selected function", async () => {
  const entryPoint = {
    id: "EntryPoint",
    name: "EntryPoint",
    address: "0x0000000000000000000000000000000000004337",
    functions: [{ name: "handleOps", signature: "handleOps(bytes,address)", selector: "0x765e827f", stateMutability: "nonpayable", inputs: [], outputs: [] }],
    events: [], errors: []
  };
  const loom = { ...contract, id: "LoomAccount", name: "LoomAccount", address: "0x0000000000000000000000000000000000000020" };
  const tracedDeployment = { nodes: [entryPoint, loom], edges: [] };
  const hash = `0x${"12".repeat(32)}`;
  const rpc = async (method, params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionByHash") return { hash, from: "0x0000000000000000000000000000000000000001", to: entryPoint.address, input: "0x765e827f", value: "0x0" };
    if (method === "eth_getTransactionReceipt") return { status: "0x1", transactionHash: hash, blockHash: `0x${"34".repeat(32)}`, blockNumber: "0x10", gasUsed: "0x5208", logs: [] };
    if (method === "debug_traceTransaction" && params[1]?.tracer === "callTracer") return { type: "CALL", to: entryPoint.address, input: "0x765e827f", calls: [{ type: "CALL", from: entryPoint.address, to: loom.address, input: "0x55241077", gasUsed: "0x100" }] };
    throw new Error("optional trace unavailable");
  };

  const result = await analyzeDeploymentTransaction({ rpc, deployment: tracedDeployment, chainId: 11155111, transactionHash: hash });
  assert.equal(result.provenance.classification, "loom-confirmed");
  assert.equal(result.provenance.entryPointTransport, true);
  assert.deepEqual(result.touchedContracts.map(item => item.contractId), ["EntryPoint", "LoomAccount"]);
  assert.equal(result.trace.calls[0].functionSignature, "setValue(uint256)");
});

test("transaction analysis verifies a Loom account proxy from UserOperationEvent when tracing is unavailable", async () => {
  const sender = "0x00000000000000000000000000000000000000aa";
  const implementation = "0x0000000000000000000000000000000000000020";
  const placeholder = "00".repeat(32);
  const proxyCreationCode = `0x6000fe6080604052600436107f${placeholder}507f${placeholder}50`;
  const proxyRuntime = materializeLoomProxyRuntime({ proxyCreationCode, implementation });
  const event = {
    name: "UserOperationEvent",
    signature: "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
    topic: keccak256("0x"),
    anonymous: false,
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "paymaster", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "actualGasCost", type: "uint256", indexed: false },
      { name: "actualGasUsed", type: "uint256", indexed: false }
    ]
  };
  const entryPoint = { id: "EntryPoint", name: "EntryPoint", address: "0x0000000000000000000000000000000000004337", functions: [], events: [event], errors: [] };
  const eventAbi = { type: "event", name: event.name, anonymous: false, inputs: event.inputs };
  const userOpHash = `0x${"56".repeat(32)}`;
  const topics = encodeEventTopics({ abi: [eventAbi], eventName: event.name, args: { userOpHash, sender, paymaster: "0x0000000000000000000000000000000000000000" } });
  const data = encodeAbiParameters(event.inputs.filter(input => !input.indexed), [1n, true, 2n, 3n]);
  const hash = `0x${"78".repeat(32)}`;
  const rpc = async (method, params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionByHash") return { hash, to: entryPoint.address, input: "0x765e827f", value: "0x0" };
    if (method === "eth_getTransactionReceipt") return { status: "0x1", blockHash: `0x${"90".repeat(32)}`, blockNumber: "0x20", gasUsed: "0x100", logs: [{ address: entryPoint.address, topics, data }] };
    if (method === "eth_getCode" && params[1] === "latest") return proxyRuntime;
    throw new Error("public RPC does not expose traces");
  };

  const result = await analyzeDeploymentTransaction({ rpc, deployment: { nodes: [entryPoint], edges: [] }, chainId: 11155111, transactionHash: hash, loomProxyRuntimeCodeHash: keccak256(proxyRuntime) });
  assert.equal(result.provenance.classification, "loom-confirmed");
  assert.equal(result.provenance.accounts[0].address.toLowerCase(), sender);
  assert.deepEqual({ ...result.provenance.accounts[0], address: sender }, { address: sender, runtime: "verified", userOperationHash: userOpHash, success: true });
  assert.equal(result.capabilities.callTrace, "unavailable");
});

test("local function probe attempts every ABI function without publishing transactions", async () => {
  const methods = [];
  const rpc = async (method, params) => {
    methods.push(method);
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_call" && params[0].data.startsWith("0x55241077")) throw Object.assign(new Error("reverted"), { data: "0x82b42900" });
    if (method === "eth_call") return encodeAbiParameters([{ type: "uint256" }], [7n]);
    if (method === "debug_traceCall") return { type: "STATICCALL", to: contract.address, input: params[0].data };
    throw new Error("unexpected RPC method");
  };

  const result = await probeDeploymentFunctions({ rpc, deployment, chainId: 31337, from: "0x0000000000000000000000000000000000000001" });
  assert.deepEqual({ attempted: result.attempted, succeeded: result.succeeded, reverted: result.reverted }, { attempted: 2, succeeded: 1, reverted: 1 });
  assert.deepEqual(result.results.map(item => item.function.signature), ["readValue(uint256)", "setValue(uint256)"]);
  assert.equal(result.results[0].arguments[0], "0");
  assert.equal(methods.includes("eth_sendTransaction"), false);
});
