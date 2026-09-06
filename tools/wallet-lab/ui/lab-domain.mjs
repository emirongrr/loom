const EVIDENCE_KINDS = new Set([
  "observed_client",
  "observed_onchain",
  "observed_rpc",
  "observed_trace",
  "observed_receipt",
  "observed_event",
  "observed_state_diff",
  "derived_from_artifact",
  "derived_from_source",
  "derived_from_manifest",
  "derived_from_configuration",
  "derived_from_simulation",
  "inferred",
  "unavailable"
]);

const CONFIDENCE = new Set(["verified", "observed", "derived", "inferred", "unknown"]);
const REFERENCE_FIELDS = ["chainId", "blockNumber", "transactionHash", "userOperationHash", "contractAddress", "selector", "sourcePath", "traceFrameId", "rpcMethod", "timestamp"];

export function createEvidenceReference(kind, confidence, description, references = {}) {
  if (!EVIDENCE_KINDS.has(kind)) throw new Error(`unsupported evidence kind: ${kind}`);
  if (!CONFIDENCE.has(confidence)) throw new Error(`unsupported evidence confidence: ${confidence}`);
  if (!description || typeof description !== "string") throw new Error("evidence description is required");
  const evidence = { kind, confidence, description };
  for (const field of REFERENCE_FIELDS) if (references[field] !== undefined && references[field] !== null) evidence[field] = references[field];
  return Object.freeze(evidence);
}

function latestEvent(events, phase) {
  return [...events].reverse().find(event => event.phase === phase) ?? null;
}

function flattenTrace(frame, path = "0", parentPath = null, output = []) {
  if (!frame) return output;
  output.push({ ...frame, path, parentPath });
  for (const [index, child] of (frame.calls ?? []).entries()) flattenTrace(child, `${path}.${index}`, path, output);
  return output;
}

function nodeFor(deployment, id) {
  return (deployment?.nodes ?? []).find(node => node.id === id) ?? null;
}

function nodeAtAddress(deployment, address) {
  if (!address) return null;
  return (deployment?.nodes ?? []).find(node => node.address?.toLowerCase() === String(address).toLowerCase()) ?? null;
}

function traceEvidence(frame, description, artifact) {
  return createEvidenceReference("observed_trace", "observed", description, {
    chainId: artifact?.environment?.chainId,
    transactionHash: frame.transactionHash,
    contractAddress: frame.to,
    selector: frame.selector,
    traceFrameId: frame.path
  });
}

function eventEvidence(kind, confidence, description, event, extra = {}) {
  return createEvidenceReference(kind, confidence, description, {
    chainId: event?.chainId,
    blockNumber: event?.blockNumber,
    transactionHash: event?.transactionHash,
    userOperationHash: event?.userOpHash,
    sourcePath: event?.source?.file,
    timestamp: event?.timestamp,
    ...extra
  });
}

function architectureGraph(deployment) {
  const nodes = (deployment?.nodes ?? []).map(node => ({
    id: node.id,
    kind: node.kind,
    label: node.name,
    address: node.address,
    explanation: node.responsibility ?? "Deployment component.",
    evidence: [createEvidenceReference("derived_from_manifest", "derived", "Component is declared by the selected deployment evidence.", { contractAddress: node.address, sourcePath: node.source?.path })]
  }));
  const edges = (deployment?.edges ?? []).map(edge => ({
    id: `architecture:${edge.from}:${edge.to}:${edge.kind}`,
    graph: "architecture",
    source: edge.from,
    target: edge.to,
    relationship: edge.kind,
    explanation: edge.label,
    evidence: [createEvidenceReference("derived_from_artifact", "derived", "Relationship is derived from repository-maintained deployment evidence and validated contract artifacts.")]
  }));
  return { nodes, edges };
}

function executionGraph(deployment, tracePayload, artifact) {
  const frames = flattenTrace(tracePayload?.trace);
  const nodes = frames.map(frame => {
    const contract = frame.contractId ? nodeFor(deployment, frame.contractId) : nodeAtAddress(deployment, frame.to);
    return {
      id: `trace:${frame.path}`,
      kind: contract?.kind ?? "external",
      label: contract?.name ?? frame.contractName ?? frame.to ?? "Unknown call target",
      address: frame.to,
      explanation: frame.functionSignature ?? frame.selector ?? frame.type ?? "Observed EVM call frame.",
      evidence: [traceEvidence(frame, "Call frame was returned by the selected RPC trace.", artifact)]
    };
  });
  const edges = frames.filter(frame => frame.parentPath !== null).map(frame => ({
    id: `execution:${frame.parentPath}:${frame.path}:${String(frame.type ?? "CALL").toLowerCase()}`,
    graph: "execution",
    source: `trace:${frame.parentPath}`,
    target: `trace:${frame.path}`,
    relationship: String(frame.type ?? "CALL").toLowerCase(),
    explanation: `${frame.type ?? "CALL"} executed ${frame.functionSignature ?? frame.selector ?? frame.to ?? "an external frame"}.`,
    evidence: [traceEvidence(frame, "Parent-child relationship was observed in the call trace.", artifact)]
  }));
  return { nodes, edges, frames };
}

function authorityModel({ artifact, deployment, execution }) {
  const events = artifact?.events ?? [];
  const actors = new Map();
  const edges = [];
  const addActor = (id, abilities, explanation, evidence) => {
    const node = nodeFor(deployment, id);
    const current = actors.get(id);
    actors.set(id, {
      id,
      label: node?.name ?? id,
      kind: node?.kind ?? "infrastructure",
      address: node?.address,
      abilities: [...new Set([...(current?.abilities ?? []), ...abilities])],
      explanation,
      evidence: [...(current?.evidence ?? []), evidence]
    });
  };
  const addEdge = (source, target, relationship, explanation, evidence) => edges.push({ id: `authority:${source}:${target}:${relationship}`, graph: "authority", source, target, relationship, explanation, evidence: [evidence] });
  const frameFor = id => execution.frames.find(frame => frame.contractId === id);
  const webauthn = latestEvent(events, "webauthn");
  const bundler = latestEvent(events, "bundler-submission");
  const inclusion = latestEvent(events, "inclusion");
  const accountFrame = frameFor("ObservedAccount") ?? frameFor("LoomAccount");
  const validatorFrame = frameFor("P256Validator");
  const hookFrame = frameFor("PolicyHook");
  const entryPointFrame = frameFor("EntryPoint");
  const targetFrame = execution.frames.find(frame => frame.contractId && !["EntryPoint", "ObservedAccount", "LoomAccount", "P256Validator", "PolicyHook"].includes(frame.contractId));

  if (webauthn) {
    const evidence = eventEvidence("observed_client", "observed", "The recorded client completed a WebAuthn assertion for this operation.", webauthn);
    addActor("Authenticator", ["approve", "observe"], "The authenticator can approve only the exact challenge presented by the client; it does not publish the operation.", evidence);
    addActor("P256Validator", ["approve", "reject"], "The configured validator decides whether the passkey assertion authorizes this account operation.", validatorFrame ? traceEvidence(validatorFrame, "Validator execution was observed in the call trace.", artifact) : evidence);
    addEdge("Authenticator", "P256Validator", "approves", "The passkey assertion is consumed by the configured P-256 validator.", evidence);
  }
  if (validatorFrame) addEdge("P256Validator", "ObservedAccount", "validates", "The validator returned authority to the account validation boundary.", traceEvidence(validatorFrame, "Validator call was observed in the transaction trace.", artifact));
  if (hookFrame) {
    const evidence = traceEvidence(hookFrame, "Policy-hook enforcement was observed in the transaction trace.", artifact);
    addActor("PolicyHook", ["veto", "constrain"], "The installed hook can reject execution that violates the configured policy; it cannot forge a validator signature.", evidence);
    addEdge("PolicyHook", "ObservedAccount", "enforces", "The hook constrains an otherwise authorized account execution.", evidence);
  }
  if (bundler) {
    const evidence = eventEvidence("observed_rpc", "observed", "The UserOperation was submitted to the configured bundler transport.", bundler, { rpcMethod: bundler.payload?.method ?? "eth_sendUserOperation" });
    addActor("Bundler", ["publish", "delay", "refuse_service", "observe"], "The bundler can simulate, publish, delay, or refuse the operation, but it cannot change the signed intent.", evidence);
    addEdge("Bundler", "EntryPoint", "publishes", "The bundler forwards the signed UserOperation to EntryPoint.", evidence);
  }
  if (entryPointFrame) {
    const evidence = traceEvidence(entryPointFrame, "EntryPoint execution was observed in the transaction trace.", artifact);
    addActor("EntryPoint", ["execute_transport", "settle_gas"], "EntryPoint authenticates the ERC-4337 transport path and settles the operation gas.", evidence);
    addEdge("EntryPoint", "ObservedAccount", "executes", "EntryPoint called the account's fixed ERC-4337 validation and execution surfaces.", evidence);
  }
  if (accountFrame || inclusion) {
    const evidence = accountFrame ? traceEvidence(accountFrame, "Account authority and execution were observed in the transaction trace.", artifact) : eventEvidence("observed_receipt", "observed", "A receipt-bound account operation was recorded.", inclusion);
    addActor("ObservedAccount", ["move_funds", "execute", "change_configuration"], "Only an account-authorized path can execute calls or change account configuration; each sensitive path remains constrained by its contract rules.", evidence);
  }
  if (targetFrame && accountFrame) {
    const evidence = traceEvidence(targetFrame, "Target call was observed in the transaction trace.", artifact);
    const transferredValue = targetFrame.value && targetFrame.value !== "0x" ? BigInt(targetFrame.value) > 0n : false;
    addActor(targetFrame.contractId, [transferredValue ? "receive_value" : "receive_call", "observe"], "The target receives the exact account call after Loom authorization and policy enforcement have succeeded.", evidence);
    addEdge("ObservedAccount", targetFrame.contractId, transferredValue ? "transfers_value" : "calls", "The account executed the selected target call after validation and hook checks.", evidence);
  }

  return { actors: [...actors.values()], edges };
}

function privacyModel({ artifact, deployment, execution }) {
  const events = artifact?.events ?? [];
  const disclosures = [];
  const add = (id, observer, dataCategory, visibility, explanation, evidence) => disclosures.push({ id, observer, dataCategory, visibility, explanation, evidence: [evidence] });
  const webauthn = latestEvent(events, "webauthn");
  const bundler = latestEvent(events, "bundler-submission");
  const network = latestEvent(events, "network");
  const inclusion = latestEvent(events, "inclusion");
  const targetFrame = execution.frames.find(frame => frame.contractId && !["EntryPoint", "ObservedAccount", "LoomAccount", "P256Validator", "PolicyHook"].includes(frame.contractId));

  if (webauthn) add("privacy:authenticator:webauthn", "Authenticator", "RP ID, origin, challenge, credential selection, and ceremony timing", "disclosed_to_specific_party", "This metadata participates in the local WebAuthn ceremony. It is not automatically a public-chain fact, but the authenticator and client can observe it.", eventEvidence("observed_client", "observed", "WebAuthn ceremony metadata was recorded by the test client.", webauthn));
  if (network) {
    const methods = (network.payload?.exchanges ?? []).map(exchange => exchange.request?.method).filter(Boolean);
    add("privacy:rpc:requests", "RPC provider", "Queried addresses, RPC methods, chain context, and request timing", "disclosed_to_infrastructure", "The selected RPC can correlate the methods and public addresses sent through that endpoint. Wallet Lab stores only a sanitized endpoint identity.", eventEvidence("observed_rpc", "observed", `Captured ${methods.length} redacted RPC exchanges.`, network, { rpcMethod: methods[0] }));
  }
  if (bundler) add("privacy:bundler:userop", "Bundler", "Full submitted UserOperation, sender, calldata, gas fields, and timing", "disclosed_to_infrastructure", "The bundler receives the complete UserOperation required for simulation and publication. This is transport disclosure, not account authority.", eventEvidence("observed_rpc", "observed", "Bundler submission was captured with secret-bearing transport metadata redacted.", bundler, { rpcMethod: bundler.payload?.method ?? "eth_sendUserOperation" }));
  if (inclusion) add("privacy:chain:operation", "Public blockchain", "Account, EntryPoint transaction, calldata, events, value movement, gas, and timing", "revealed_onchain", "Once included, transaction calldata, logs, participating public addresses, gas, and resulting public state are observable and linkable on-chain.", eventEvidence("observed_receipt", "verified", "The operation is bound to an included transaction receipt.", inclusion));
  if (targetFrame) add("privacy:target:call", "Contract target", "Caller account, calldata, value, and execution timing", "disclosed_to_counterparty", "The called contract observes the account caller and exact EVM call data. Public execution may make the same data visible to every chain observer.", traceEvidence(targetFrame, "Target disclosure is derived from the observed target call frame.", artifact));

  if (!disclosures.length) add("privacy:unknown", "Unknown", "Observer visibility", "unknown", "No client, transport, receipt, or trace evidence is available for an observer-specific privacy claim.", createEvidenceReference("unavailable", "unknown", "The selected artifact contains no privacy-relevant runtime evidence."));
  return disclosures;
}

function effectsModel(artifact) {
  return (artifact?.stateDiff ?? []).map((effect, index) => ({
    id: `effect:${index}:${String(effect.name).toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
    label: effect.name,
    before: effect.before,
    after: effect.after,
    explanation: effect.explanation,
    evidence: [createEvidenceReference("observed_state_diff", "verified", "The deterministic run independently read this semantic value before and after execution.", { chainId: artifact?.environment?.chainId })]
  }));
}

export function buildOperationLens({ artifact, deployment, tracePayload, selectedContractId = null }) {
  const architecture = architectureGraph(deployment);
  const execution = executionGraph(deployment, tracePayload, artifact);
  const authority = authorityModel({ artifact, deployment, execution });
  const privacy = privacyModel({ artifact, deployment, execution });
  const effects = effectsModel(artifact);
  const notices = [];
  if (!tracePayload?.trace) notices.push("Trace unavailable: execution and authority views use receipt, client, RPC, and manifest evidence only.");
  if (!effects.length) notices.push("State-difference evidence is unavailable for this operation.");
  return {
    operation: {
      id: artifact?.runId ?? "unavailable",
      title: artifact?.scenario?.title ?? artifact?.scenarioId ?? "Unknown operation",
      status: artifact?.status ?? "unknown",
      chainId: artifact?.environment?.chainId ?? null,
      selectedContractId
    },
    capabilities: {
      trace: tracePayload?.trace ? "available" : "unavailable",
      stateDiff: effects.length ? "available" : "unavailable",
      receipt: latestEvent(artifact?.events ?? [], "inclusion") ? "available" : "unavailable"
    },
    architecture,
    execution: { nodes: execution.nodes, edges: execution.edges },
    authority,
    effects,
    privacy,
    notices
  };
}
