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
