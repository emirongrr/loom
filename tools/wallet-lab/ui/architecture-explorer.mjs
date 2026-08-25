const REQUIRED = new Set(["core", "transport-required", "profile-required", "deployment-required"]);
const DEPLOYMENT_REQUIRED_CONTRACTS = new Set([
  "RecoveryManager",
  "P256RecoveryValidatorFactory",
  "ECDSAGuardianVerifier",
  "P256GuardianVerifier",
  "ERC1271GuardianVerifier"
]);

const ACCOUNT_TOPOLOGY = Object.freeze({
  LoomAccount: {
    name: "LoomAccount · shared code",
    topologyRole: "ONE-TIME DEPLOYED CORE",
    responsibility: "Shared immutable account logic deployed once for this factory profile. It supplies validation and execution code but does not hold any individual wallet's balance, nonce, validator set, or guardian configuration."
  },
  LoomAccountProxy: {
    name: "LoomAccountProxy · template",
    topologyRole: "WALLET BYTECODE TEMPLATE",
    responsibility: "Source-defined creation and runtime bytecode used to deploy each wallet proxy. It is a template rather than a separately deployed singleton, so it has no single deployment address."
  },
  ObservedAccount: {
    name: "Loom wallet · proxy instance",
    topologyRole: "DEPLOYED WALLET PROXY",
    responsibility: "One real LoomAccountProxy created by the factory and selected for inspection. Its address holds balances, nonce, validators, and guardian configuration while delegatecall runs the shared LoomAccount implementation in this wallet's state context."
  },
  LoomAccountFactory: {
    topologyRole: "DETERMINISTIC WALLET DEPLOYER",
    responsibility: "Uses one immutable LoomAccount implementation and deterministically deploys a separate initialized proxy contract for every Loom wallet; it has no later account authority."
  }
});

export function normalizeArchitectureDeployment(deployment) {
  if (!deployment) return null;
  const nodes = (deployment.nodes ?? []).map(node => ACCOUNT_TOPOLOGY[node.id] ? { ...node, ...ACCOUNT_TOPOLOGY[node.id] } : node);
  const hasObservedWallet = nodes.some(node => node.id === "ObservedAccount" && node.address && node.availability !== "source-only");
  const normalizedEdges = (deployment.edges ?? []).map(edge => {
    if (edge.from === "LoomAccountFactory" && edge.to === "LoomAccount") return { ...edge, kind: "references", label: "one immutable implementation shared by every wallet proxy" };
    if (edge.from === "LoomAccountFactory" && edge.to === "LoomAccountProxy") return { ...edge, kind: "uses-template", label: "CREATE2 per-wallet proxy bytecode" };
    if (edge.from === "LoomAccountFactory" && edge.to === "ObservedAccount") return { ...edge, kind: "creates", label: "CREATE2 · one proxy contract per wallet" };
    if (edge.from === "ObservedAccount" && edge.to === "LoomAccount") return { ...edge, kind: "delegates", label: "DELEGATECALL · shared code / wallet state" };
    if (hasObservedWallet && edge.from === "EntryPoint" && edge.to === "LoomAccount") return { ...edge, to: "ObservedAccount" };
    if (hasObservedWallet && edge.from === "LoomAccount" && ["validates-with", "optional-validator", "guarded-by", "optional-hook"].includes(edge.kind)) return { ...edge, from: "ObservedAccount" };
    if (hasObservedWallet && edge.from === "RecoveryManager" && edge.to === "LoomAccount" && edge.kind === "recovers") return { ...edge, to: "ObservedAccount" };
    return edge;
  });
  const seenEdges = new Set();
  const edges = normalizedEdges.filter(edge => {
    const key = `${edge.from}:${edge.to}:${edge.kind}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  return { ...deployment, nodes, edges };
}

export const ARCHITECTURE_GROUPS = Object.freeze([
  { id: "group:authentication", label: "Authentication", layers: ["authentication"] },
  { id: "group:hooks", label: "Hooks", layers: ["execution-policy", "asset-policy"] },
  { id: "group:recovery", label: "Recovery", layers: ["recovery", "guardian-verifier"] },
  { id: "group:keystore", label: "Cross-chain keystore", layers: ["keystore"] },
  { id: "group:compatibility", label: "Compatibility", layers: ["compatibility"] },
  { id: "group:sessions", label: "Sessions", layers: ["session"] },
  { id: "group:lab-only", label: "Lab only", requirement: "test-only" }
]);

function groupFor(node) {
  return ARCHITECTURE_GROUPS.find(group => group.requirement === node.requirement || group.layers?.includes(node.layer)) ?? ARCHITECTURE_GROUPS[ARCHITECTURE_GROUPS.length - 1];
}

export function buildArchitectureExplorer(deployment, { expandedGroupIds = [], searchQuery = "" } = {}) {
  const normalized = normalizeArchitectureDeployment(deployment);
  const normalizedNodes = normalized?.nodes ?? [];
  const hasObservedWallet = normalizedNodes.some(node => node.id === "ObservedAccount" && node.address && node.availability !== "source-only");
  const topologyNodes = hasObservedWallet ? normalizedNodes.filter(node => node.id !== "LoomAccountProxy") : normalizedNodes;
  const nodes = topologyNodes.map(node => DEPLOYMENT_REQUIRED_CONTRACTS.has(node.id) && node.requirement !== "deployment-required"
    ? { ...node, requirement: "deployment-required" }
    : node);
  const edges = normalized?.edges ?? [];
  const expanded = new Set(expandedGroupIds);
  const query = searchQuery.trim().toLowerCase();
  const requiredNodes = nodes.filter(node => REQUIRED.has(node.requirement));
  const optionalNodes = nodes.filter(node => !REQUIRED.has(node.requirement));
  const groups = ARCHITECTURE_GROUPS.map((definition, architectureGroupIndex) => {
    const members = optionalNodes.filter(node => groupFor(node).id === definition.id);
    return { ...definition, architectureGroupIndex, members, count: members.length, expanded: expanded.has(definition.id) };
  }).filter(group => group.count > 0);
  const visibleOptional = [];
  const visibleGroups = [];
  for (const group of groups) {
    const matches = query ? group.members.filter(node => [node.id, node.name, node.layer, node.responsibility].some(value => String(value ?? "").toLowerCase().includes(query))) : [];
    const presentMembers = members => members.map((node, index) => ({
      ...node,
      architectureGroupId: group.id,
      architectureGroupLabel: group.label,
      architectureGroupIndex: group.architectureGroupIndex,
      architectureGroupOrder: index
    }));
    if (group.expanded) visibleOptional.push(...presentMembers(group.members));
    else if (matches.length) visibleOptional.push(...presentMembers(matches));
    else visibleGroups.push({
      id: group.id,
      name: group.label,
      label: group.label,
      nodeType: "group",
      kind: "group",
      requirement: group.requirement ?? "optional",
      layer: "presentation-group",
      architectureGroupIndex: group.architectureGroupIndex,
      count: group.count,
      memberIds: group.members.map(node => node.id),
      responsibility: `${group.count} discoverable contract${group.count === 1 ? "" : "s"}. This is a visual group, not an on-chain authority boundary.`
    });
  }
  const visibleNodes = [...requiredNodes, ...visibleOptional, ...visibleGroups];
  const visibleIds = new Set(visibleNodes.filter(node => node.nodeType !== "group").map(node => node.id));
  const visibleEdges = edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return {
    visibleNodes,
    visibleEdges,
    groups,
    collapsedGroups: visibleGroups.map(group => group.id),
    expandedGroupIds: [...expanded]
  };
}

function traceRecords(node, parent = null, result = []) {
  if (!node) return result;
  result.push({ frame: node, parent });
  for (const child of node.calls ?? []) traceRecords(child, node, result);
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function buildFunctionExecutionLens({ deployment, contractId, functionSelector, trace } = {}) {
  const nodes = deployment?.nodes ?? [];
  const edges = deployment?.edges ?? [];
  const addressToId = new Map(nodes.filter(node => node.address).map(node => [node.address.toLowerCase(), node.id]));
  const frameId = frame => frame?.contractId ?? (typeof frame?.to === "string" ? addressToId.get(frame.to.toLowerCase()) : null);
  const relatedEdges = edges.filter(edge => edge.from === contractId || edge.to === contractId);
  const records = traceRecords(trace);
  const matches = records.filter(({ frame }) => frameId(frame) === contractId && frame.selector === functionSelector);
  const observedNodeIds = [];
  const observedEdges = [];
  const calls = matches.map(({ frame, parent }) => {
    const frames = [];
    const visit = (current, parentFrame = null, depth = 0) => {
      const currentId = frameId(current);
      const parentId = frameId(parentFrame);
      if (depth === 0 && parentId) observedNodeIds.push(parentId);
      if (currentId) observedNodeIds.push(currentId);
      if (parentId && currentId && parentId !== currentId) observedEdges.push({ from: parentId, to: currentId, type: current.type ?? "CALL" });
      frames.push({
        depth,
        contractId: currentId ?? null,
        contractName: current.contractName ?? nodes.find(node => node.id === currentId)?.name ?? null,
        type: current.type ?? "CALL",
        functionSignature: current.functionSignature ?? null,
        selector: current.selector ?? null,
        from: current.from ?? null,
        to: current.to ?? null,
        value: current.value ?? null,
        gasUsed: current.gasUsed ?? null,
        input: current.input ?? null,
        output: current.output ?? null,
        error: current.error ?? null,
        revertReason: current.revertReason ?? null
      });
      for (const child of current.calls ?? []) visit(child, current, depth + 1);
    };
    visit(frame, parent, 0);
    const callerId = frameId(parent);
    return {
      caller: parent ? {
        contractId: callerId ?? null,
        contractName: parent.contractName ?? nodes.find(node => node.id === callerId)?.name ?? null,
        from: frame.from ?? parent.to ?? null,
        callType: frame.type ?? "CALL"
      } : null,
      frames
    };
  });
  const observedIds = unique(observedNodeIds);
  const possibleNodeIds = unique(relatedEdges.map(edge => edge.from === contractId ? edge.to : edge.from)).filter(id => id !== contractId && !observedIds.includes(id));
  const edgeKeys = new Set();
  const uniqueObservedEdges = observedEdges.filter(edge => {
    const key = `${edge.from}:${edge.to}:${edge.type}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });
  return {
    status: calls.length ? "observed" : "architecture-only",
    contractId,
    functionSelector,
    calls,
    observedNodeIds: observedIds,
    observedEdges: uniqueObservedEdges,
    possibleNodeIds
  };
}

function journeyDescription(node) {
  if (node.id === "EntryPoint") return "Receives the published ERC-4337 bundle, validates each UserOperation, and settles gas without owning the account.";
  if (node.id === "ObservedAccount") return "Holds this wallet's state and delegates immutable account logic while remaining the UserOperation sender.";
  if (node.id === "LoomAccount") return "Runs the account validation or execution function in the wallet instance's storage context.";
  if (node.layer === "authentication") return "Checks the configured signature authority before the account accepts the operation.";
  if (["execution-policy", "asset-policy"].includes(node.layer)) return "Applies the installed policy checks around account execution.";
  if (["recovery", "guardian-verifier"].includes(node.layer)) return "Participates in the deployment's bounded recovery path when this transaction invokes it.";
  return node.responsibility ?? "Observed deployment contract call.";
}

export function buildTransactionArchitectureJourney(deployment, result) {
  if (result?.kind !== "transaction-analysis") return { verified: false, stages: [], observedNodeIds: [] };
  const nodes = deployment?.nodes ?? [];
  const addressToId = new Map(nodes.filter(node => node.address).map(node => [node.address.toLowerCase(), node.id]));
  const frameId = frame => frame?.contractId ?? (typeof frame?.to === "string" ? addressToId.get(frame.to.toLowerCase()) : null);
  const records = traceRecords(result.trace);
  const observedNodeIds = unique(records.map(({ frame }) => frameId(frame)));
  const stages = [{
    id: "publisher",
    label: "Publisher / bundler executor",
    address: result.transaction?.from ?? null,
    description: "This address submitted the transaction and paid transaction gas. For a bundled UserOperation it is the bundler executor, but the address alone does not prove the service identity.",
    tone: "verified"
  }];
  const renderedObservedIds = new Set();
  const renderedExternalCalls = new Set();
  let renderedUserOperations = false;
  for (const { frame } of records) {
    const id = frameId(frame);
    const node = nodes.find(candidate => candidate.id === id);
    if (node && !renderedObservedIds.has(id)) {
      renderedObservedIds.add(id);
      stages.push({ id, contractId: id, label: node.name, address: node.address ?? null, description: journeyDescription(node), tone: "observed" });
      if (id === "EntryPoint" && !renderedUserOperations) {
        for (const account of result.provenance?.accounts ?? []) {
          stages.push({
            id: `user-operation:${account.userOperationHash ?? account.address}`,
            label: account.success === false ? "UserOperation reverted" : "UserOperation accepted",
            address: account.address,
            description: `${account.userOperationHash ?? "Decoded EntryPoint event"} binds this account sender to the enclosing transaction receipt.`,
            tone: account.success === false ? "failed" : "observed"
          });
        }
        renderedUserOperations = true;
      }
      continue;
    }
    if (node || typeof frame?.to !== "string") continue;
    const value = (() => { try { return BigInt(frame.value ?? 0); } catch { return 0n; } })();
    const hasCalldata = typeof frame.input === "string" && frame.input.length >= 10;
    if (value === 0n && !hasCalldata) continue;
    const externalId = `${frame.type ?? "CALL"}:${frame.to.toLowerCase()}:${frame.selector ?? "0x"}:${value}`;
    if (renderedExternalCalls.has(externalId)) continue;
    renderedExternalCalls.add(externalId);
    stages.push({
      id: `external:${externalId}`,
      label: value > 0n ? "Value transfer / external call" : `External ${frame.type ?? "CALL"}`,
      address: frame.to,
      description: `${frame.type ?? "CALL"} forwarded ${value} wei${hasCalldata ? ` with selector ${frame.selector}` : " without calldata"}. This target is outside the selected deployment.`,
      tone: frame.error ? "failed" : "external"
    });
  }
  if (!observedNodeIds.length && result.provenance?.entryPointTransport) {
    const entryPoint = nodes.find(node => node.id === "EntryPoint");
    if (entryPoint) stages.push({ id: "EntryPoint", contractId: "EntryPoint", label: entryPoint.name, address: entryPoint.address, description: journeyDescription(entryPoint), tone: "shared" });
  }
  for (const account of result.provenance?.accounts ?? []) {
    if (account.runtime !== "verified" || renderedObservedIds.has("ObservedAccount")) continue;
    const observedAccount = nodes.find(node => node.id === "ObservedAccount");
    stages.push({ id: `account:${account.address}`, ...(observedAccount ? { contractId: observedAccount.id } : {}), label: "Verified Loom account", address: account.address, description: "The UserOperation sender matched the trusted immutable Loom proxy runtime.", tone: "verified" });
  }
  stages.push({
    id: "receipt",
    label: result.status === "success" ? "Receipt confirmed execution" : "Receipt recorded a revert",
    description: result.status === "success" ? "The mined receipt reports success; trace and state evidence remain dependent on RPC capabilities." : "The mined receipt reports failure and all transaction state writes were reverted.",
    tone: result.status === "success" ? "verified" : "failed"
  });
  return {
    verified: result.provenance?.classification === "loom-confirmed",
    classification: result.provenance?.classification ?? "inconclusive",
    basis: result.provenance?.basis ?? "no-loom-evidence",
    stages,
    observedNodeIds
  };
}

export function reduceArchitectureFocus(state, action) {
  if (action.type === "focus-node") return { focusedNodeId: action.nodeId, focusedSection: null, focusedAbiItem: null };
  if (action.type === "focus-section") return { ...state, focusedSection: action.section, focusedAbiItem: null };
  if (action.type === "focus-abi") return { ...state, focusedSection: action.section ?? state.focusedSection, focusedAbiItem: action.itemId };
  if (action.type === "clear") return { focusedNodeId: null, focusedSection: null, focusedAbiItem: null };
  if (action.type === "escape") {
    if (state.focusedAbiItem) return { ...state, focusedAbiItem: null };
    if (state.focusedSection) return { ...state, focusedSection: null, focusedAbiItem: null };
  }
  return state;
}
