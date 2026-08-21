import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbiItem
} from "viem";
import { compactOpcodeTrace, normalizeCallTrace, summarizeCallTrace } from "./deployment-evidence.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const MAX_VALUE_WEI = (1n << 256n) - 1n;
const MAX_STATE_ACCOUNTS = 64;
const MAX_STATE_SLOTS = 128;
const MAX_PROBE_FUNCTIONS = 384;
const PROBE_CONCURRENCY = 4;
const PROXY_RUNTIME_MARKER = "fe608060405260043610";

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

export function materializeLoomProxyRuntime({ proxyCreationCode, implementation }) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/u.test(String(proxyCreationCode))) throw new Error("proxy creation code must be hexadecimal bytes");
  if (!ADDRESS.test(String(implementation))) throw new Error("proxy implementation must contain 20 bytes");
  const creation = String(proxyCreationCode).slice(2).toLowerCase();
  const marker = creation.indexOf(PROXY_RUNTIME_MARKER);
  if (marker < 0) throw new Error("proxy creation code does not contain the trusted Loom runtime boundary");
  const placeholder = `7f${"0".repeat(64)}`;
  const replacement = `7f${String(implementation).slice(2).toLowerCase().padStart(64, "0")}`;
  const template = creation.slice(marker + 2);
  const matches = template.split(placeholder).length - 1;
  if (matches !== 2) throw new Error("proxy runtime must contain exactly two implementation commitments");
  return `0x${template.replaceAll(placeholder, replacement)}`;
}

export function loomProxyRuntimeCodeHash(input) {
  return keccak256(materializeLoomProxyRuntime(input));
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

function probeDefault(parameter, sender) {
  if (parameter.type.endsWith("]")) {
    const match = /^(.*)\[(\d*)\]$/u.exec(parameter.type);
    const length = match?.[2] ? Number(match[2]) : 0;
    const child = { ...parameter, type: match?.[1] ?? parameter.type };
    return Array.from({ length }, () => probeDefault(child, sender));
  }
  if (parameter.type === "tuple") return (parameter.components ?? []).map(component => probeDefault(component, sender));
  if (parameter.type === "address") return sender;
  if (parameter.type === "bool") return false;
  if (parameter.type === "string") return "";
  if (parameter.type === "function") return `0x${"0".repeat(48)}`;
  if (/^bytes(?:\d+)?$/u.test(parameter.type)) {
    const width = Number(/^bytes(\d+)$/u.exec(parameter.type)?.[1] ?? 0);
    return `0x${"0".repeat(width * 2)}`;
  }
  if (/^u?int(?:\d+)?$/u.test(parameter.type)) return 0n;
  throw new Error(`no deterministic probe value is available for ${parameter.type}`);
}

function probeResultBase(contract, fn, values) {
  return {
    contract: { id: contract.id, name: contract.name, address: contract.address },
    function: { name: fn.name, signature: fn.signature, selector: fn.selector, stateMutability: fn.stateMutability },
    arguments: jsonSafe(values)
  };
}

async function mapBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function probeDeploymentFunctions({ rpc, deployment, chainId, from, contractIds } = {}) {
  if (typeof rpc !== "function") throw new Error("local probe RPC is required");
  if (!ADDRESS.test(String(from))) throw new Error("local probe caller must contain 20 bytes");
  const observedChainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (observedChainId !== Number(chainId) || observedChainId !== 31337) throw new Error("function probing is restricted to the selected local devnet");
  const requested = contractIds === undefined ? null : new Set(contractIds);
  if (requested && (!Array.isArray(contractIds) || contractIds.some(id => typeof id !== "string"))) throw new Error("probe contract IDs must be an array of deployment identifiers");
  const contracts = (deployment?.nodes ?? []).filter(contract => !requested || requested.has(contract.id));
  if (requested && contracts.length !== requested.size) throw new Error("probe scope contains a contract outside this deployment");
  const work = contracts.flatMap(contract => (contract.functions ?? []).map(fn => ({ contract, fn })));
  if (!work.length) throw new Error("probe scope does not expose ABI functions");
  if (work.length > MAX_PROBE_FUNCTIONS) throw new Error(`probe scope exceeds the ${MAX_PROBE_FUNCTIONS} function limit`);

  const results = await mapBounded(work, PROBE_CONCURRENCY, async ({ contract, fn }) => {
    let abi;
    let values;
    let prepared;
    try {
      abi = functionAbi(fn);
      values = abi.inputs.map(parameter => probeDefault(parameter, from));
      prepared = prepareDeploymentCall({ deployment, chainId, contractId: contract.id, selector: fn.selector, args: jsonSafe(values), valueWei: "0", from });
    } catch (error) {
      return { ...probeResultBase(contract, fn, values ?? []), status: "unsupported-input", message: error?.message ?? "deterministic probe input could not be generated", trace: null, traceSummary: null };
    }
    const callTrace = optionalRpc(rpc, "debug_traceCall", [prepared.transaction, "latest", { tracer: "callTracer" }]);
    try {
      const output = await rpc("eth_call", [prepared.transaction, "latest"]);
      const resolvedTrace = await callTrace;
      const trace = resolvedTrace.status === "available" ? normalizeCallTrace(resolvedTrace.value, deployment) : null;
      let decoded = null;
      if (fn.outputs?.length) {
        try { decoded = jsonSafe(decodeFunctionResult({ abi: [abi], functionName: fn.name, data: output })); } catch { decoded = null; }
      }
      return { ...probeResultBase(contract, fn, values), status: "success", output: { raw: output, decoded }, trace, traceSummary: trace ? summarizeCallTrace(trace) : null };
    } catch (error) {
      const resolvedTrace = await callTrace;
      const trace = resolvedTrace.status === "available" ? normalizeCallTrace(resolvedTrace.value, deployment) : null;
      return { ...probeResultBase(contract, fn, values), status: "reverted", revert: decodeRevert(contract, errorData(error)), trace, traceSummary: trace ? summarizeCallTrace(trace) : null };
    }
  });
  return {
    kind: "function-probe",
    chainId: observedChainId,
    published: false,
    attempted: results.length,
    succeeded: results.filter(result => result.status === "success").length,
    reverted: results.filter(result => result.status === "reverted").length,
    unsupported: results.filter(result => result.status === "unsupported-input").length,
    results
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

function flattenNormalizedTrace(trace, result = []) {
  if (!trace) return result;
  result.push(trace);
  for (const child of trace.calls ?? []) flattenNormalizedTrace(child, result);
  return result;
}

function annotateVerifiedAccounts(trace, accounts) {
  if (!trace) return null;
  const address = trace.to?.toLowerCase();
  const account = address ? accounts.get(address) : null;
  return {
    ...trace,
    ...(account && !trace.contractId ? { contractId: "ObservedAccount", contractName: "Verified Loom account", loomAccount: true } : {}),
    calls: (trace.calls ?? []).map(child => annotateVerifiedAccounts(child, accounts))
  };
}

function touchedContracts(deployment, trace, events, verifiedAccounts) {
  const catalog = new Map((deployment?.nodes ?? []).map(node => [node.address.toLowerCase(), node]));
  const touched = new Map();
  const add = (address, source, frame = null) => {
    if (!ADDRESS.test(String(address))) return;
    const key = address.toLowerCase();
    const contract = catalog.get(key);
    const account = verifiedAccounts.get(key);
    const current = touched.get(key) ?? {
      address,
      contractId: contract?.id ?? (account ? "ObservedAccount" : null),
      name: contract?.name ?? (account ? "Verified Loom account" : "External contract"),
      role: contract ? "deployment" : account ? "loom-account" : "external",
      calls: 0,
      logs: 0,
      functions: []
    };
    if (source === "call") {
      current.calls += 1;
      if (frame?.functionSignature && !current.functions.includes(frame.functionSignature)) current.functions.push(frame.functionSignature);
    } else current.logs += 1;
    touched.set(key, current);
  };
  for (const frame of flattenNormalizedTrace(trace)) add(frame.to, "call", frame);
  for (const event of events) add(event.address, "log");
  return [...touched.values()];
}

function eventArgument(event, name, index) {
  if (event?.args && !Array.isArray(event.args) && Object.prototype.hasOwnProperty.call(event.args, name)) return event.args[name];
  return Array.isArray(event?.args) ? event.args[index] : null;
}

export async function analyzeDeploymentTransaction({ rpc, deployment, chainId, transactionHash, loomProxyRuntimeCodeHash: expectedProxyHash }) {
  if (!HASH.test(String(transactionHash))) throw new Error("transaction hash must contain 32 bytes");
  const observedChainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (observedChainId !== Number(chainId)) throw new Error("execution RPC chain does not match the selected deployment");
  const transaction = await rpc("eth_getTransactionByHash", [transactionHash]);
  if (!transaction) throw new Error("transaction is not available from the selected RPC");
  const receipt = await waitForReceipt(rpc, transactionHash);
  if (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("transaction receipt hash does not match the requested transaction");

  const callTrace = optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { tracer: "callTracer" }]);
  const opcodeTrace = optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { disableMemory: true, disableStack: true, disableStorage: true }]);
  const stateTrace = optionalRpc(rpc, "debug_traceTransaction", [transactionHash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
  const events = decodeLogs(deployment, receipt.logs);
  const userOperations = events.filter(event => event.contractId === "EntryPoint" && event.name === "UserOperationEvent");
  const uniqueSenders = [...new Set(userOperations.map(event => String(eventArgument(event, "sender", 1) ?? "").toLowerCase()).filter(address => ADDRESS.test(address)))];
  const runtimeChecks = new Map(await Promise.all(uniqueSenders.map(async address => {
    const historicalCode = await optionalRpc(rpc, "eth_getCode", [address, receipt.blockNumber]);
    const code = historicalCode.status === "available" ? historicalCode : await optionalRpc(rpc, "eth_getCode", [address, "latest"]);
    const observedHash = code.status === "available" && typeof code.value === "string" && code.value !== "0x" ? keccak256(code.value) : null;
    const verified = Boolean(expectedProxyHash && observedHash?.toLowerCase() === expectedProxyHash.toLowerCase());
    return [address, { address, runtime: verified ? "verified" : observedHash ? "mismatch" : "unavailable", observedCodeHash: observedHash, observedAt: historicalCode.status === "available" ? receipt.blockNumber : code.status === "available" ? "latest" : null }];
  })));
  const accounts = userOperations.map(event => {
    const address = String(eventArgument(event, "sender", 1) ?? "");
    const runtime = runtimeChecks.get(address.toLowerCase()) ?? { runtime: "unavailable" };
    return {
      address,
      runtime: runtime.runtime,
      userOperationHash: eventArgument(event, "userOpHash", 0),
      success: eventArgument(event, "success", 4)
    };
  });
  const verifiedAccounts = new Map([...runtimeChecks].filter(([, check]) => check.runtime === "verified"));
  const [resolvedCallTrace, resolvedOpcodeTrace, resolvedStateTrace] = await Promise.all([callTrace, opcodeTrace, stateTrace]);
  const evidence = traceEvidence(deployment, resolvedCallTrace, resolvedOpcodeTrace, resolvedStateTrace);
  evidence.trace = annotateVerifiedAccounts(evidence.trace, verifiedAccounts);
  evidence.traceSummary = evidence.trace ? summarizeCallTrace(evidence.trace) : null;
  const frames = flattenNormalizedTrace(evidence.trace);
  const entryPoint = deployment.nodes.find(node => node.id === "EntryPoint");
  const direct = deployment.nodes.find(node => node.address.toLowerCase() === transaction.to?.toLowerCase());
  const knownLoomFrames = frames.filter(frame => frame.contractId && frame.contractId !== "EntryPoint");
  const entryPointTransport = Boolean(entryPoint && (transaction.to?.toLowerCase() === entryPoint.address.toLowerCase() || frames.some(frame => frame.contractId === "EntryPoint")));
  const verifiedUserOperation = accounts.some(account => account.runtime === "verified");
  const trustedDeploymentInteraction = Boolean((direct && direct.id !== "EntryPoint") || knownLoomFrames.length);
  const classification = verifiedUserOperation || trustedDeploymentInteraction
    ? "loom-confirmed"
    : entryPointTransport
      ? "erc4337-only"
      : evidence.capabilities.callTrace === "available"
        ? "unrelated"
        : "inconclusive";
  const basis = verifiedUserOperation ? "verified-account-user-operation" : trustedDeploymentInteraction ? "trusted-deployment-code" : entryPointTransport ? "shared-entrypoint-only" : "no-loom-evidence";
  const touched = touchedContracts(deployment, evidence.trace, events, verifiedAccounts);

  return {
    kind: "transaction-analysis",
    chainId: observedChainId,
    status: receipt.status === "0x1" ? "success" : "reverted",
    transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    transaction,
    events,
    touchedContracts: touched,
    provenance: {
      classification,
      basis,
      entryPointTransport,
      deploymentCodeObserved: trustedDeploymentInteraction,
      accounts,
      checks: [
        { label: "Chain identity", status: "verified", detail: String(observedChainId) },
        { label: "Receipt binding", status: "verified", detail: transactionHash },
        { label: "Loom deployment code", status: trustedDeploymentInteraction ? "verified" : "not-observed", detail: knownLoomFrames.map(frame => frame.contractId).filter(Boolean).join(", ") || direct?.id || null },
        { label: "Loom account runtime", status: verifiedUserOperation ? "verified" : accounts.length ? "unverified" : "not-observed", detail: accounts.map(account => `${account.address}:${account.runtime}`).join(", ") || null }
      ]
    },
    ...evidence
  };
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
