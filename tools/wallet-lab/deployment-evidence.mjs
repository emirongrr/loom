import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const suffix = input.type.slice("tuple".length);
  return `(${(input.components ?? []).map(canonicalType).join(",")})${suffix}`;
}

function functionSignature(item) {
  return `${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
}

function genericBehavior(contractName, item) {
  const key = `${contractName}.${item.name}`;
  if (BEHAVIORS[key]) return BEHAVIORS[key];
  if (item.stateMutability === "pure") return "Computes a result from calldata only. It cannot read or persist contract storage.";
  if (item.stateMutability === "view") return "Reads contract or chain state without persisting a state change when invoked as an eth_call.";
  if (item.stateMutability === "payable") return "May accept native value and may change state. Exact calls, checks, and reverts depend on input and current chain state.";
  return "May change contract state but rejects attached native value. Exact calls, checks, and reverts depend on input and current chain state.";
}

export function catalogFunctions(contractName, abi) {
  return abi
    .filter(item => item.type === "function")
    .map(item => {
      const signature = functionSignature(item);
      return {
        name: item.name,
        signature,
        selector: keccak256(stringToHex(signature)).slice(0, 10),
        stateMutability: item.stateMutability,
        inputs: (item.inputs ?? []).map(input => ({ name: input.name, type: canonicalType(input), internalType: input.internalType ?? input.type })),
        outputs: (item.outputs ?? []).map(output => ({ name: output.name, type: canonicalType(output), internalType: output.internalType ?? output.type })),
        behavior: genericBehavior(contractName, item)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.signature.localeCompare(right.signature));
}

function relationship(from, to, kind, label) {
  return { from, to, kind, label };
}

export function buildDeploymentEvidence({ repoRoot, addresses, codeHashes, account }) {
  const nodes = Object.entries(addresses).map(([name, address]) => {
    const artifactParts = ARTIFACTS[name];
    const artifactPath = artifactParts ? join(repoRoot, ...artifactParts) : null;
    const artifact = artifactPath && existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, "utf8")) : null;
    return {
      id: name,
      name,
      address,
      runtimeCodeHash: codeHashes[name] ?? null,
      kind: name === "EntryPoint" ? "protocol" : name === "LoomAccount" ? "account" : name.includes("Factory") ? "factory" : name.includes("Validator") ? "validator" : name.includes("Hook") ? "hook" : name === "RecoveryManager" ? "recovery" : "contract",
      functions: artifact ? catalogFunctions(name, artifact.abi ?? []) : []
    };
  });
  if (account) {
    const accountArtifactPath = join(repoRoot, ...ARTIFACTS.LoomAccount);
    const accountArtifact = existsSync(accountArtifactPath) ? JSON.parse(readFileSync(accountArtifactPath, "utf8")) : null;
    nodes.push({
      id: "ObservedAccount",
      name: "Observed Loom account",
      address: account,
      runtimeCodeHash: null,
      kind: "account",
      functions: accountArtifact ? catalogFunctions("LoomAccount", accountArtifact.abi ?? []) : []
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

export function compactOpcodeTrace(rawTrace, limit = 400) {
  const logs = Array.isArray(rawTrace?.structLogs) ? rawTrace.structLogs : [];
  const opcodeCounts = {};
  for (const step of logs) opcodeCounts[step.op] = (opcodeCounts[step.op] ?? 0) + 1;
  const importantSteps = logs
    .filter(step => IMPORTANT_OPCODES.has(step.op))
    .slice(0, limit)
    .map((step, index) => ({
      index,
      pc: step.pc,
      op: step.op,
      depth: step.depth,
      gas: step.gas,
      gasCost: step.gasCost
    }));
  return {
    totalSteps: logs.length,
    failed: Boolean(rawTrace?.failed),
    gas: rawTrace?.gas ?? null,
    returnValue: rawTrace?.returnValue ?? null,
    truncated: importantSteps.length < logs.filter(step => IMPORTANT_OPCODES.has(step.op)).length,
    opcodeCounts,
    importantSteps
  };
}
