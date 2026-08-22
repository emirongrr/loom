const REQUIRED = new Set(["core", "transport-required", "profile-required"]);

export const ARCHITECTURE_GROUPS = Object.freeze([
  { id: "group:authentication", label: "Authentication", layers: ["authentication"] },
  { id: "group:hooks", label: "Hooks", layers: ["execution-policy", "asset-policy"] },
  { id: "group:recovery", label: "Recovery", layers: ["recovery", "guardian-verifier"] },
  { id: "group:sessions", label: "Sessions", layers: ["session"] },
  { id: "group:lab-only", label: "Lab only", requirement: "test-only" }
]);

function groupFor(node) {
  return ARCHITECTURE_GROUPS.find(group => group.requirement === node.requirement || group.layers?.includes(node.layer)) ?? ARCHITECTURE_GROUPS[ARCHITECTURE_GROUPS.length - 1];
}

export function buildArchitectureExplorer(deployment, { expandedGroupIds = [], searchQuery = "" } = {}) {
  const nodes = deployment?.nodes ?? [];
  const edges = deployment?.edges ?? [];
  const expanded = new Set(expandedGroupIds);
  const query = searchQuery.trim().toLowerCase();
  const requiredNodes = nodes.filter(node => REQUIRED.has(node.requirement));
  const optionalNodes = nodes.filter(node => !REQUIRED.has(node.requirement));
  const groups = ARCHITECTURE_GROUPS.map(definition => {
    const members = optionalNodes.filter(node => groupFor(node).id === definition.id);
    return { ...definition, members, count: members.length, expanded: expanded.has(definition.id) };
  }).filter(group => group.count > 0);
  const visibleOptional = [];
  const visibleGroups = [];
  for (const group of groups) {
    const matches = query ? group.members.filter(node => [node.id, node.name, node.layer, node.responsibility].some(value => String(value ?? "").toLowerCase().includes(query))) : [];
    if (group.expanded) visibleOptional.push(...group.members);
    else if (matches.length) visibleOptional.push(...matches);
    else visibleGroups.push({
      id: group.id,
      name: group.label,
      label: group.label,
      nodeType: "group",
      kind: "group",
      requirement: group.requirement ?? "optional",
      layer: "presentation-group",
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
