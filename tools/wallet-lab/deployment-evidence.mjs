import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { keccak256, stringToHex } from "viem";

const ARTIFACTS = Object.freeze({
  EntryPoint: ["out", "EntryPoint.sol", "EntryPoint.json"],
  LoomAccount: ["out", "LoomAccount.sol", "LoomAccount.json"],
  LoomAccountFactory: ["out", "LoomAccountFactory.sol", "LoomAccountFactory.json"],
  P256Validator: ["out", "P256Validator.sol", "P256Validator.json"],
  PolicyHook: ["out", "PolicyHook.sol", "PolicyHook.json"],
  VaultHook: ["out", "VaultHook.sol", "VaultHook.json"],
  ECDSAValidator: ["out", "ECDSAValidator.sol", "ECDSAValidator.json"],
  P256RecoveryValidatorFactory: ["out", "P256RecoveryValidatorFactory.sol", "P256RecoveryValidatorFactory.json"],
  ExactCallSessionValidator: ["out", "ExactCallSessionValidator.sol", "ExactCallSessionValidator.json"],
  GranularSessionValidator: ["out", "GranularSessionValidator.sol", "GranularSessionValidator.json"],
  RecoveryManager: ["out", "RecoveryManager.sol", "RecoveryManager.json"],
  ECDSAGuardianVerifier: ["out", "ECDSAGuardianVerifier.sol", "ECDSAGuardianVerifier.json"],
  P256GuardianVerifier: ["out", "P256GuardianVerifier.sol", "P256GuardianVerifier.json"],
  ERC1271GuardianVerifier: ["out", "ERC1271GuardianVerifier.sol", "ERC1271GuardianVerifier.json"],
  DevnetTarget: ["out", "DeployDevnet.s.sol", "DevnetTarget.json"]
});

const BEHAVIORS = Object.freeze({
  "EntryPoint.handleOps": "Validates each ERC-4337 operation, invokes the sender account, executes accepted calls, and settles gas with the beneficiary.",
  "LoomAccount.validateUserOp": "Accepts calls only from the configured EntryPoint, routes the signature envelope to an installed validator, and funds any required prefund.",
  "LoomAccount.execute": "Decodes Loom's bounded execution mode, applies freeze and hook policy, then performs the committed single call or atomic batch.",
  "LoomAccount.executeDirect": "Verifies a validator-bound direct execution digest and replay nonce before entering the same guarded execution path without a bundler.",
  "LoomAccount.installModule": "Changes account authority by installing a supported validator, hook, or recovery module through an account-authorized self-call.",
  "LoomAccount.uninstallModule": "Changes account authority by removing an installed module through the account's constrained configuration path.",
  "LoomAccount.freeze": "Verifies one configured guardian capability and pauses ordinary account execution for the contract's bounded emergency window.",
  "LoomAccountFactory.createAccount": "Deploys the immutable account proxy at its deterministic CREATE2 address and initializes the committed account configuration.",
  "P256Validator.validateUserOp": "Checks WebAuthn origin, RP ID, challenge, UP/UV flags, and a low-s P-256 signature for the canonical UserOperation hash.",
  "PolicyHook.preCheck": "Runs before account execution and rejects calls that exceed the installed target, selector, counterparty, or spending policy.",
  "PolicyHook.postCheck": "Runs after execution to finalize policy accounting for the successfully completed call.",
  "RecoveryManager.proposeRecovery": "Verifies threshold guardian approvals and records a delayed, expiring validator and guardian replacement commitment.",
  "RecoveryManager.executeRecovery": "After the delay, atomically applies the exact committed validator set and guardian configuration through the account's narrow recovery entry point.",
  "DevnetTarget.setValue": "Writes the supplied integer to the target's value storage slot; used only as an observable local test effect."
});

const CONTRACT_PROFILES = Object.freeze({
  EntryPoint: { layer: "erc-4337-transport", requirement: "transport-required", responsibility: "Canonical ERC-4337 validation, execution, and gas settlement transport. Loom direct execution remains the provider-independent fallback." },
  LoomAccount: { layer: "loom-core", requirement: "core", responsibility: "Immutable smart-account authority boundary and guarded execution engine." },
  ObservedAccount: { layer: "account-instance", requirement: "core", responsibility: "The deployed immutable proxy instance whose state and execution are being observed." },
  LoomAccountFactory: { layer: "deployment", requirement: "core", responsibility: "Deterministically deploys and initializes immutable Loom account proxies; it has no later account authority." },
  P256Validator: { layer: "authentication", requirement: "profile-required", responsibility: "Primary passkey validator for the observed wallet profile." },
  PolicyHook: { layer: "execution-policy", requirement: "profile-required", responsibility: "Applies the observed account's low-risk execution and spending policy." },
  ECDSAValidator: { layer: "authentication", requirement: "optional", responsibility: "Optional validator for migration, testing, and hardware-wallet integrations." },
  ExactCallSessionValidator: { layer: "session", requirement: "optional", responsibility: "Optional time-, use-, call-, and paymaster-bound session authority." },
  GranularSessionValidator: { layer: "session", requirement: "optional", responsibility: "Optional reusable target, selector, amount, counterparty, and time-bounded session authority." },
  VaultHook: { layer: "asset-policy", requirement: "optional", responsibility: "Optional daily-spend and delayed-withdrawal policy for protected assets." },
  RecoveryManager: { layer: "recovery", requirement: "deployment-required", responsibility: "Required deployment-level delayed guardian-threshold validator and guardian replacement path. Each account still configures its own guardian set." },
  P256RecoveryValidatorFactory: { layer: "recovery", requirement: "deployment-required", responsibility: "Required permissionless provisioning path for a recovered P-256 validator." },
  ECDSAGuardianVerifier: { layer: "guardian-verifier", requirement: "deployment-required", responsibility: "Required deployment support for ECDSA guardian proofs bound into guardian leaves." },
  P256GuardianVerifier: { layer: "guardian-verifier", requirement: "deployment-required", responsibility: "Required deployment support for P-256 passkey guardian proofs bound into guardian leaves." },
  ERC1271GuardianVerifier: { layer: "guardian-verifier", requirement: "deployment-required", responsibility: "Required deployment support for contract-wallet guardian proofs using ERC-1271." },
  DevnetTarget: { layer: "scenario", requirement: "test-only", responsibility: "Local-only target used to make the test state transition independently observable." }
});

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const suffix = input.type.slice("tuple".length);
  return `(${(input.components ?? []).map(canonicalType).join(",")})${suffix}`;
}

function functionSignature(item) {
  return `${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
}

function catalogAbiParameter(input) {
  return {
    name: input.name,
    type: canonicalType(input),
    internalType: input.internalType ?? input.type,
    ...(input.components?.length ? { components: input.components.map(catalogAbiParameter) } : {})
  };
}

function genericBehavior(contractName, item) {
  const key = `${contractName}.${item.name}`;
  if (BEHAVIORS[key]) return BEHAVIORS[key];
  if (item.stateMutability === "pure") return "Computes a result from calldata only. It cannot read or persist contract storage.";
  if (item.stateMutability === "view") return "Reads contract or chain state without persisting a state change when invoked as an eth_call.";
  if (item.stateMutability === "payable") return "May accept native value and may change state. Exact calls, checks, and reverts depend on input and current chain state.";
  return "May change contract state but rejects attached native value. Exact calls, checks, and reverts depend on input and current chain state.";
}

function documentationText(documentation) {
  const text = typeof documentation === "string" ? documentation : documentation?.text;
  return text?.replace(/\s+/gu, " ").trim() || null;
}

function humanizeIdentifier(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replaceAll("_", " ").toLowerCase();
}

function functionPurpose(contractName, item, documentation) {
  if (documentation) return documentation;
  const known = BEHAVIORS[`${contractName}.${item.name}`];
  if (known) return known;
  const subject = humanizeIdentifier(item.name);
  if (item.stateMutability === "pure") return `Provides the contract's deterministic ${subject} calculation without depending on stored state.`;
  if (item.stateMutability === "view") return `Exposes ${subject} so clients and other contracts can inspect the relevant state without changing it.`;
  if (item.stateMutability === "payable") return `Provides the state-changing ${subject} entry point and allows the caller to attach native value when the operation requires it.`;
  return `Provides the state-changing ${subject} entry point used to update this contract through its declared authorization and validation rules.`;
}

function fieldPurpose(node, category, documentation) {
  if (documentation) return documentation;
  const subject = humanizeIdentifier(node.name);
  if (category === "constant") return `Defines the fixed ${subject} value used by this contract so every call applies the same compile-time rule.`;
  if (category === "immutable") return `Binds ${subject} during deployment so the contract can rely on it without granting a later configuration path.`;
  return `Persists ${subject} between calls because later validation or execution depends on this contract-owned state.`;
}

function astFunctionMetadata(contractName, ast) {
  const contract = ast?.nodes?.find(node => node.nodeType === "ContractDefinition" && node.name === contractName);
  return new Map((contract?.nodes ?? []).filter(node => node.nodeType === "FunctionDefinition" && node.functionSelector).map(node => {
    const [start, length] = String(node.src ?? "").split(":").map(Number);
    return [`0x${node.functionSelector}`, {
      sourceRange: Number.isSafeInteger(start) && Number.isSafeInteger(length) ? { start, length } : null,
      documentation: documentationText(node.documentation)
    }];
  }));
}

export function catalogFunctions(contractName, abi, ast = null) {
  const metadata = astFunctionMetadata(contractName, ast);
  return abi
    .filter(item => item.type === "function")
    .map(item => {
      const signature = functionSignature(item);
      const selector = keccak256(stringToHex(signature)).slice(0, 10);
      const source = metadata.get(selector);
      return {
        name: item.name,
        signature,
        selector,
        stateMutability: item.stateMutability,
        inputs: (item.inputs ?? []).map(catalogAbiParameter),
        outputs: (item.outputs ?? []).map(catalogAbiParameter),
        behavior: genericBehavior(contractName, item),
        purpose: functionPurpose(contractName, item, source?.documentation),
        sourceRange: source?.sourceRange ?? null
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.signature.localeCompare(right.signature));
}

export function catalogEvents(abi) {
  return abi.filter(item => item.type === "event").map(item => {
    const signature = `${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
    return {
      name: item.name,
      signature,
      topic: keccak256(stringToHex(signature)),
      anonymous: Boolean(item.anonymous),
      inputs: (item.inputs ?? []).map(input => ({ name: input.name, type: canonicalType(input), indexed: Boolean(input.indexed) }))
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.signature.localeCompare(right.signature));
}

export function catalogErrors(abi) {
  return abi.filter(item => item.type === "error").map(item => {
    const signature = `${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
    return {
      name: item.name,
      signature,
      selector: keccak256(stringToHex(signature)).slice(0, 10),
      inputs: (item.inputs ?? []).map(input => ({ name: input.name, type: canonicalType(input) }))
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.signature.localeCompare(right.signature));
}

function sourceSlice(sourceCode, src) {
  const [start, length] = String(src ?? "").split(":").map(Number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) return null;
  return sourceCode?.slice(start, start + length).trim() || null;
}

function evaluateNumericConstant(node) {
  if (!node) return null;
  if (node.nodeType === "Literal" && node.kind === "number" && typeof node.value === "string") {
    try { return BigInt(node.value); } catch { return null; }
  }
  if (node.nodeType === "FunctionCall" && node.kind === "typeConversion" && node.arguments?.length === 1) {
    return evaluateNumericConstant(node.arguments[0]);
  }
  if (node.nodeType === "UnaryOperation" && node.operator === "-") {
    const value = evaluateNumericConstant(node.subExpression);
    return value === null ? null : -value;
  }
  if (node.nodeType !== "BinaryOperation") return null;
  const left = evaluateNumericConstant(node.leftExpression);
  const right = evaluateNumericConstant(node.rightExpression);
  if (left === null || right === null) return null;
  try {
    if (node.operator === "<<" && right >= 0n && right <= 4096n) return left << right;
    if (node.operator === ">>" && right >= 0n && right <= 4096n) return left >> right;
    if (node.operator === "|") return left | right;
    if (node.operator === "&") return left & right;
    if (node.operator === "^") return left ^ right;
    if (node.operator === "+") return left + right;
    if (node.operator === "-") return left - right;
    if (node.operator === "*") return left * right;
    if (node.operator === "/" && right !== 0n) return left / right;
  } catch {
    return null;
  }
  return null;
}

function formatResolvedConstant(value, type) {
  if (value === null) return null;
  const bytes = /^bytes(\d+)$/u.exec(type ?? "");
  if (bytes) {
    const width = Number(bytes[1]);
    if (!Number.isSafeInteger(width) || width < 1 || width > 32 || value < 0n || value >= (1n << BigInt(width * 8))) return null;
    return `0x${value.toString(16).padStart(width * 2, "0")}`;
  }
  if (/^uint(?:\d+)?$/u.test(type ?? "") && value >= 0n) return value.toString();
  if (/^int(?:\d+)?$/u.test(type ?? "")) return value.toString();
  return null;
}

function resolveConstantValue(repoRoot, node) {
  if (!node.constant || !node.value) return null;
  let valueNode = node.value;
  if (valueNode.nodeType === "MemberAccess" && valueNode.expression?.nodeType === "Identifier") {
    const libraryName = valueNode.expression.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(libraryName)) return null;
    const artifactPath = join(repoRoot, "out", `${libraryName}.sol`, `${libraryName}.json`);
    if (!existsSync(artifactPath)) return null;
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      const library = artifact.ast?.nodes?.find(item => item.nodeType === "ContractDefinition" && item.name === libraryName);
      const declaration = library?.nodes?.find(item => item.nodeType === "VariableDeclaration" && item.constant && item.name === valueNode.memberName);
      valueNode = declaration?.value;
    } catch {
      return null;
    }
  }
  return formatResolvedConstant(evaluateNumericConstant(valueNode), node.typeDescriptions?.typeString ?? node.typeName?.name);
}

export function catalogFields(contractName, ast, sourceCode, functions, repoRoot) {
  const contract = ast?.nodes?.find(node => node.nodeType === "ContractDefinition" && node.name === contractName);
  return (contract?.nodes ?? []).filter(node => node.nodeType === "VariableDeclaration" && node.stateVariable).map(node => {
    const category = node.constant ? "constant" : node.mutability === "immutable" ? "immutable" : "storage";
    const getter = functions.find(fn => fn.name === node.name);
    const documentation = documentationText(node.documentation);
    return {
      name: node.name,
      type: node.typeDescriptions?.typeString ?? node.typeName?.name ?? "unknown",
      category,
      visibility: node.visibility ?? "internal",
      value: sourceSlice(sourceCode, node.value?.src),
      resolvedValue: repoRoot ? resolveConstantValue(repoRoot, node) : null,
      documentation,
      purpose: fieldPurpose(node, category, documentation),
      getter: getter?.signature ?? null
    };
  }).sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
}

function relationship(from, to, kind, label) {
  return { from, to, kind, label };
}

function sourceEvidence(repoRoot, artifact) {
  const target = artifact?.metadata?.settings?.compilationTarget;
  const [sourcePath, contractName] = Object.entries(target ?? {})[0] ?? [];
  if (!sourcePath || isAbsolute(sourcePath)) return null;
  const absolutePath = resolve(repoRoot, sourcePath);
  const relativePath = relative(resolve(repoRoot), absolutePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || !existsSync(absolutePath)) return null;
  const code = readFileSync(absolutePath, "utf8");
  const declarationIndex = code.search(new RegExp(`\\b(?:abstract\\s+)?(?:contract|interface|library)\\s+${contractName}\\b`, "u"));
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  const upstream = normalizedPath === "lib/account-abstraction/contracts/core/EntryPoint.sol"
    ? {
        repository: "eth-infinitism/account-abstraction",
        revision: "v0.9.0",
        path: "contracts/core/EntryPoint.sol"
      }
    : undefined;
  return {
    path: normalizedPath,
    contractName,
    declarationLine: declarationIndex < 0 ? null : code.slice(0, declarationIndex).split(/\r?\n/u).length,
    language: artifact.metadata?.language ?? "Solidity",
    compilerVersion: artifact.metadata?.compiler?.version ?? null,
    ...(upstream ? { upstream } : {}),
    code
  };
}

function nodeEvidence({ address, runtimeCodeHash, artifact, source }) {
  return [
    { kind: "manifest", status: "declared", label: "Deployment manifest", detail: `Address ${address}` },
    ...(runtimeCodeHash ? [{ kind: "runtime-code", status: "declared", label: "Runtime bytecode commitment", detail: runtimeCodeHash }] : []),
    ...(artifact ? [{ kind: "artifact", status: "derived", label: "Local compiler artifact", detail: source?.path ?? "Foundry artifact" }] : [])
  ];
}

export function buildDeploymentEvidence({ repoRoot, addresses, codeHashes, account }) {
  const nodes = Object.entries(addresses).map(([name, address]) => {
    const artifactParts = ARTIFACTS[name];
    const artifactPath = artifactParts ? join(repoRoot, ...artifactParts) : null;
    const artifact = artifactPath && existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, "utf8")) : null;
    const source = sourceEvidence(repoRoot, artifact);
    const runtimeCodeHash = codeHashes[name] ?? null;
    const functions = artifact ? catalogFunctions(name, artifact.abi ?? [], artifact.ast) : [];
    return {
      id: name,
      name,
      address,
      runtimeCodeHash,
      kind: name === "EntryPoint" ? "protocol" : name === "LoomAccount" ? "account" : name.includes("Factory") ? "factory" : name.includes("Validator") ? "validator" : name.includes("Hook") ? "hook" : name === "RecoveryManager" ? "recovery" : "contract",
      ...(CONTRACT_PROFILES[name] ?? { layer: "external", requirement: "deployed", responsibility: "Deployed contract discovered in this manifest." }),
      functions,
      events: artifact ? catalogEvents(artifact.abi ?? []) : [],
      errors: artifact ? catalogErrors(artifact.abi ?? []) : [],
      fields: artifact ? catalogFields(name, artifact.ast, source?.code, functions, repoRoot) : [],
      source,
      evidence: nodeEvidence({ address, runtimeCodeHash, artifact, source })
    };
  });
  if (account) {
    const accountArtifactPath = join(repoRoot, ...ARTIFACTS.LoomAccount);
    const accountArtifact = existsSync(accountArtifactPath) ? JSON.parse(readFileSync(accountArtifactPath, "utf8")) : null;
    const accountSource = sourceEvidence(repoRoot, accountArtifact);
    const accountFunctions = accountArtifact ? catalogFunctions("LoomAccount", accountArtifact.abi ?? [], accountArtifact.ast) : [];
    nodes.push({
      id: "ObservedAccount",
      name: "Observed Loom account",
      address: account,
      runtimeCodeHash: null,
      kind: "account",
      ...CONTRACT_PROFILES.ObservedAccount,
      functions: accountFunctions,
      events: accountArtifact ? catalogEvents(accountArtifact.abi ?? []) : [],
      errors: accountArtifact ? catalogErrors(accountArtifact.abi ?? []) : [],
      fields: accountArtifact ? catalogFields("LoomAccount", accountArtifact.ast, accountSource?.code, accountFunctions, repoRoot) : [],
      source: accountSource,
      evidence: [
        { kind: "manifest", status: "declared", label: "Observed run account", detail: account },
        { kind: "artifact", status: "derived", label: "Proxy implementation ABI", detail: "src/LoomAccount.sol" }
      ]
    });
  }
  const edges = [
    relationship("LoomAccountFactory", "LoomAccount", "creates", "CREATE2 proxy / immutable implementation"),
    relationship("EntryPoint", "LoomAccount", "invokes", "validateUserOp / execute"),
    relationship("LoomAccount", "P256Validator", "validates-with", "WebAuthn P-256 authority"),
    relationship("LoomAccount", "PolicyHook", "guarded-by", "pre/post execution policy"),
    relationship("RecoveryManager", "LoomAccount", "recovers", "delayed validator replacement"),
    relationship("ECDSAGuardianVerifier", "RecoveryManager", "approves", "ECDSA guardian proof"),
    relationship("P256GuardianVerifier", "RecoveryManager", "approves", "P-256 guardian proof"),
    relationship("ERC1271GuardianVerifier", "RecoveryManager", "approves", "contract guardian proof"),
    relationship("P256RecoveryValidatorFactory", "P256Validator", "creates", "recovered passkey validator"),
    relationship("LoomAccountFactory", "ObservedAccount", "creates", "CREATE2 immutable proxy"),
    relationship("ObservedAccount", "LoomAccount", "delegates", "immutable implementation"),
    relationship("EntryPoint", "ObservedAccount", "invokes", "validateUserOp / execute"),
    relationship("ObservedAccount", "P256Validator", "validates-with", "WebAuthn P-256 authority"),
    relationship("ObservedAccount", "PolicyHook", "guarded-by", "pre/post execution policy"),
    relationship("RecoveryManager", "ObservedAccount", "recovers", "delayed validator replacement"),
    relationship("ObservedAccount", "DevnetTarget", "calls", "scenario execution target"),
    relationship("P256RecoveryValidatorFactory", "ObservedAccount", "provisions-for", "recovered validator"),
    relationship("ObservedAccount", "VaultHook", "optional-hook", "asset withdrawal policy"),
    relationship("ObservedAccount", "ExactCallSessionValidator", "optional-validator", "exact-call session"),
    relationship("ObservedAccount", "GranularSessionValidator", "optional-validator", "bounded reusable session")
  ].filter(edge => nodes.some(node => node.id === edge.from) && nodes.some(node => node.id === edge.to));
  return { nodes, edges };
}

export function normalizeCallTrace(trace, catalog, depth = 0) {
  if (!trace || typeof trace !== "object") return null;
  const address = typeof trace.to === "string" ? trace.to.toLowerCase() : null;
  const contract = catalog.nodes.find(node => node.address.toLowerCase() === address);
  const selector = typeof trace.input === "string" && trace.input.length >= 10 ? trace.input.slice(0, 10).toLowerCase() : "0x";
  const fn = contract?.functions.find(candidate => candidate.selector.toLowerCase() === selector);
  return {
    depth,
    type: trace.type ?? "CALL",
    from: trace.from ?? null,
    to: trace.to ?? null,
    contractId: contract?.id ?? null,
    contractName: contract?.name ?? null,
    selector,
    functionSignature: fn?.signature ?? null,
    value: trace.value ?? "0x0",
    gas: trace.gas ?? null,
    gasUsed: trace.gasUsed ?? null,
    input: trace.input ?? "0x",
    output: trace.output ?? null,
    error: trace.error ?? null,
    revertReason: trace.revertReason ?? null,
    calls: (trace.calls ?? []).map(call => normalizeCallTrace(call, catalog, depth + 1)).filter(Boolean)
  };
}

export function summarizeCallTrace(trace) {
  const summary = { calls: 0, maxDepth: 0, errors: 0, opcodes: {} };
  const visit = node => {
    if (!node) return;
    summary.calls += 1;
    summary.maxDepth = Math.max(summary.maxDepth, node.depth ?? 0);
    if (node.error) summary.errors += 1;
    summary.opcodes[node.type] = (summary.opcodes[node.type] ?? 0) + 1;
    for (const child of node.calls ?? []) visit(child);
  };
  visit(trace);
  return summary;
}

const IMPORTANT_OPCODES = new Set([
  "CALL", "STATICCALL", "DELEGATECALL", "CREATE", "CREATE2",
  "SLOAD", "SSTORE", "TLOAD", "TSTORE", "KECCAK256",
  "LOG0", "LOG1", "LOG2", "LOG3", "LOG4", "REVERT", "RETURN", "SELFDESTRUCT"
]);

export function compactOpcodeTrace(rawTrace, limit = 400, stepLimit = 1_200) {
  const logs = Array.isArray(rawTrace?.structLogs) ? rawTrace.structLogs : [];
  const opcodeCounts = {};
  for (const step of logs) opcodeCounts[step.op] = (opcodeCounts[step.op] ?? 0) + 1;
  const compactStep = (step, index) => ({
    index,
    pc: step.pc,
    op: step.op,
    depth: step.depth,
    gas: step.gas,
    gasCost: step.gasCost
  });
  const steps = logs.slice(0, stepLimit).map(compactStep);
  const importantSteps = logs
    .map(compactStep)
    .filter(step => IMPORTANT_OPCODES.has(step.op))
    .slice(0, limit);
  return {
    totalSteps: logs.length,
    failed: Boolean(rawTrace?.failed),
    gas: rawTrace?.gas ?? null,
    returnValue: rawTrace?.returnValue ?? null,
    truncated: importantSteps.length < logs.filter(step => IMPORTANT_OPCODES.has(step.op)).length,
    stepsTruncated: steps.length < logs.length,
    opcodeCounts,
    steps,
    importantSteps
  };
}
