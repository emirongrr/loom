import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbiItem
} from "viem";
import { compactOpcodeTrace, normalizeCallTrace, summarizeCallTrace } from "./deployment-evidence.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const MAX_VALUE_WEI = (1n << 256n) - 1n;
const MAX_STATE_ACCOUNTS = 64;
const MAX_STATE_SLOTS = 128;

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return value;
}

function functionAbi(fn) {
  const mutability = fn.stateMutability === "view" || fn.stateMutability === "pure" ? ` ${fn.stateMutability}` : fn.stateMutability === "payable" ? " payable" : "";
  const outputs = fn.outputs?.length ? ` returns (${fn.outputs.map(output => output.type).join(",")})` : "";
  return parseAbiItem(`function ${fn.signature}${mutability}${outputs}`);
}

function coerceScalar(type, value) {
  if (/^u?int(?:\d+)?$/u.test(type)) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${type} must be supplied as an exact integer string`);
    try { return BigInt(value); } catch { throw new Error(`${type} must be an integer`); }
  }
  if (type === "bool") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new Error("bool must be true or false");
  }
  if (type === "address" && !ADDRESS.test(String(value))) throw new Error("address must contain 20 bytes");
  if (/^bytes(?:\d+)?$/u.test(type) && !/^0x(?:[0-9a-fA-F]{2})*$/u.test(String(value))) throw new Error(`${type} must be even-length hexadecimal bytes`);
  return String(value);
}

function parseComposite(value, label) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

function coerceArgument(parameter, value) {
  const array = /^(.*)\[(\d*)\]$/u.exec(parameter.type);
  if (array) {
    const items = parseComposite(value, parameter.type);
    if (!Array.isArray(items)) throw new Error(`${parameter.type} must be a JSON array`);
    if (array[2] && items.length !== Number(array[2])) throw new Error(`${parameter.type} requires exactly ${array[2]} items`);
    return items.map(item => coerceArgument({ ...parameter, type: array[1] }, item));
  }
  if (parameter.type === "tuple") {
    const tuple = parseComposite(value, "tuple");
    const components = parameter.components ?? [];
    if (Array.isArray(tuple)) {
      if (tuple.length !== components.length) throw new Error(`tuple requires exactly ${components.length} items`);
      return tuple.map((item, index) => coerceArgument(components[index], item));
    }
    if (!tuple || typeof tuple !== "object") throw new Error("tuple must be a JSON array or object");
    return components.map(component => coerceArgument(component, tuple[component.name]));
  }
  return coerceScalar(parameter.type, value);
}

function parseValueWei(value) {
  try {
    const parsed = BigInt(value ?? 0);
    if (parsed < 0n || parsed > MAX_VALUE_WEI) throw new Error();
    return parsed;
  } catch {
    throw new Error("call value must be an unsigned 256-bit integer");
  }
}

function resolveSelection(deployment, contractId, selector) {
  const contract = deployment?.nodes?.find(node => node.id === contractId);
  if (!contract?.address || !ADDRESS.test(contract.address)) throw new Error("selected contract is not part of this deployment");
  const fn = contract.functions?.find(candidate => candidate.selector.toLowerCase() === String(selector).toLowerCase());
  if (!fn) throw new Error("selected function is not part of this contract ABI");
  return { contract, fn };
}

function errorData(error) {
  const candidates = [error?.data, error?.rpcData, error?.cause?.data, error?.cause?.rpcData];
  return candidates.find(value => typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value)) ?? null;
}

function decodeRevert(contract, data) {
  if (!data || data === "0x") return { data: data ?? null, name: null, args: null };
  const abi = [
    { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
    { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
    ...(contract.errors ?? []).map(item => ({ type: "error", name: item.name, inputs: item.inputs ?? [] }))
  ];
  try {
    const decoded = decodeErrorResult({ abi, data });
    return { data, name: decoded.errorName, args: jsonSafe(decoded.args ?? []) };
  } catch {
    return { data, name: null, args: null };
  }
}

function stateValue(side, key) {
  return side && Object.prototype.hasOwnProperty.call(side, key) ? side[key] : null;
}

export function normalizeStateDiff(raw) {
  const pre = raw?.pre ?? {};
  const post = raw?.post ?? {};
  const addresses = [...new Set([...Object.keys(pre), ...Object.keys(post)])].slice(0, MAX_STATE_ACCOUNTS);
  let remainingSlots = MAX_STATE_SLOTS;
  const accounts = addresses.map(address => {
    const before = pre[address] ?? {};
    const after = post[address] ?? {};
    const slotKeys = [...new Set([...Object.keys(before.storage ?? {}), ...Object.keys(after.storage ?? {})])].slice(0, remainingSlots);
    remainingSlots -= slotKeys.length;
    return {
      address,
      balance: { before: stateValue(before, "balance"), after: stateValue(after, "balance") },
      nonce: { before: stateValue(before, "nonce"), after: stateValue(after, "nonce") },
      codeChanged: stateValue(before, "code") !== stateValue(after, "code"),
      storage: slotKeys.map(slot => ({ slot, before: before.storage?.[slot] ?? null, after: after.storage?.[slot] ?? null }))
    };
  });
  return {
    accounts,
    truncated: addresses.length < new Set([...Object.keys(pre), ...Object.keys(post)]).size || remainingSlots === 0
  };
}

export function prepareDeploymentCall({ deployment, chainId, contractId, selector, args = [], valueWei = "0", from }) {
  const { contract, fn } = resolveSelection(deployment, contractId, selector);
  if (!Array.isArray(args) || args.length !== (fn.inputs ?? []).length) throw new Error(`function requires exactly ${(fn.inputs ?? []).length} arguments`);
  if (from !== undefined && !ADDRESS.test(String(from))) throw new Error("caller must contain 20 bytes");
  const abi = functionAbi(fn);
  const values = abi.inputs.map((parameter, index) => coerceArgument(parameter, args[index]));
  const value = parseValueWei(valueWei);
  if (fn.stateMutability !== "payable" && value !== 0n) throw new Error("non-payable functions require zero call value");
  const data = encodeFunctionData({ abi: [abi], functionName: fn.name, args: values });
  return {
    contract,
    fn,
    abi,
    transaction: { ...(from ? { from } : {}), to: contract.address, data, value: `0x${value.toString(16)}` },
    request: { chainId, contractId, selector: fn.selector, args: jsonSafe(values), valueWei: value.toString() }
  };
}

async function optionalRpc(rpc, method, params) {
  try { return { status: "available", value: await rpc(method, params) }; }
  catch { return { status: "unavailable", value: null }; }
}

function traceEvidence(deployment, callTrace, opcodeTrace, stateTrace) {
  const trace = callTrace.status === "available" ? normalizeCallTrace(callTrace.value, deployment) : null;
  return {
    trace,
    traceSummary: trace ? summarizeCallTrace(trace) : null,
    opcodeProfile: opcodeTrace.status === "available" ? compactOpcodeTrace(opcodeTrace.value) : null,
    stateDiff: stateTrace.status === "available" ? normalizeStateDiff(stateTrace.value) : null,
    capabilities: {
      callTrace: callTrace.status,
      opcodeTrace: opcodeTrace.status,
      stateDiff: stateTrace.status
    }
  };
}

export async function simulateDeploymentCall(input) {
  const prepared = prepareDeploymentCall(input);
  const observedChainId = Number(BigInt(await input.rpc("eth_chainId", [])));
  if (observedChainId !== Number(input.chainId)) throw new Error("execution RPC chain does not match the selected deployment");
  const call = input.rpc("eth_call", [prepared.transaction, "latest"]);
  const callTrace = optionalRpc(input.rpc, "debug_traceCall", [prepared.transaction, "latest", { tracer: "callTracer" }]);
  const opcodeTrace = optionalRpc(input.rpc, "debug_traceCall", [prepared.transaction, "latest", { disableMemory: true, disableStack: true, disableStorage: true }]);
  const stateTrace = optionalRpc(input.rpc, "debug_traceCall", [prepared.transaction, "latest", { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
  let rawOutput = null;
  let failure = null;
  try { rawOutput = await call; } catch (error) { failure = decodeRevert(prepared.contract, errorData(error)); }
  const [resolvedCallTrace, resolvedOpcodeTrace, resolvedStateTrace] = await Promise.all([callTrace, opcodeTrace, stateTrace]);
  let decodedOutput = null;
  if (!failure && prepared.fn.outputs?.length) {
    try { decodedOutput = jsonSafe(decodeFunctionResult({ abi: [prepared.abi], functionName: prepared.fn.name, data: rawOutput })); }
    catch { decodedOutput = null; }
  }
  return {
    kind: "simulation",
    chainId: observedChainId,
    status: failure ? "reverted" : "success",
    contract: { id: prepared.contract.id, name: prepared.contract.name, address: prepared.contract.address },
    function: { name: prepared.fn.name, signature: prepared.fn.signature, selector: prepared.fn.selector, stateMutability: prepared.fn.stateMutability },
    transaction: prepared.transaction,
    output: { raw: rawOutput, decoded: decodedOutput },
    revert: failure,
    ...traceEvidence(input.deployment, resolvedCallTrace, resolvedOpcodeTrace, resolvedStateTrace)
  };
}

function eventAbi(contract) {
  return (contract.events ?? []).map(item => ({ type: "event", name: item.name, anonymous: item.anonymous, inputs: item.inputs ?? [] }));
}

function decodeLogs(deployment, logs = []) {
  const byAddress = new Map((deployment.nodes ?? []).map(node => [node.address?.toLowerCase(), node]));
  return logs.map(log => {
    const contract = byAddress.get(log.address?.toLowerCase());
    try {
      const decoded = decodeEventLog({ abi: eventAbi(contract ?? {}), data: log.data, topics: log.topics, strict: false });
      return { address: log.address, contractId: contract?.id ?? null, name: decoded.eventName, args: jsonSafe(decoded.args ?? {}), topics: log.topics, data: log.data };
    } catch {
      return { address: log.address, contractId: contract?.id ?? null, name: null, args: null, topics: log.topics, data: log.data };
    }
  });
}

async function waitForReceipt(rpc, hash, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("transaction receipt was not available before the bounded confirmation timeout");
}

export async function inspectDeploymentTransaction({ rpc, deployment, chainId, contractId, selector, transactionHash }) {
  if (!HASH.test(String(transactionHash))) throw new Error("transaction hash must contain 32 bytes");
  const observedChainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (observedChainId !== Number(chainId)) throw new Error("execution RPC chain does not match the selected deployment");
  const prepared = resolveSelection(deployment, contractId, selector);
  const transaction = await rpc("eth_getTransactionByHash", [transactionHash]);
  if (!transaction || transaction.to?.toLowerCase() !== prepared.contract.address.toLowerCase() || transaction.input?.slice(0, 10).toLowerCase() !== prepared.fn.selector.toLowerCase()) {
    throw new Error("transaction does not match the selected deployment function");
  }
  const receipt = await waitForReceipt(rpc, transactionHash);
  const callTrace = await optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { tracer: "callTracer" }]);
  const opcodeTrace = await optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { disableMemory: true, disableStack: true, disableStorage: true }]);
  const stateTrace = await optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
  return {
    kind: "transaction",
    chainId: observedChainId,
    status: receipt.status === "0x1" ? "success" : "reverted",
    transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    contract: { id: prepared.contract.id, name: prepared.contract.name, address: prepared.contract.address },
    function: { name: prepared.fn.name, signature: prepared.fn.signature, selector: prepared.fn.selector, stateMutability: prepared.fn.stateMutability },
    transaction,
    events: decodeLogs(deployment, receipt.logs),
    ...traceEvidence(deployment, callTrace, opcodeTrace, stateTrace)
  };
}

export async function broadcastLocalDeploymentCall(input) {
  if (Number(input.chainId) !== 31337) throw new Error("local execution is restricted to chain 31337");
  if (!ADDRESS.test(String(input.sender))) throw new Error("local test sender must contain 20 bytes");
  const simulation = await simulateDeploymentCall({ ...input, from: input.sender });
  if (simulation.status !== "success") return { ...simulation, kind: "local-preflight", broadcast: "blocked" };
  const hash = await input.rpc("eth_sendTransaction", [{ ...simulation.transaction, from: input.sender }]);
  return inspectDeploymentTransaction({ ...input, transactionHash: hash });
}
