export function layoutDeploymentGraph(nodes, { minimumHeight = 560, rowGap = 96 } = {}) {
  const positions = {};
  const left = nodes.filter(node => ["protocol", "factory", "recovery"].includes(node.kind));
  const center = nodes.filter(node => node.kind === "account");
  const right = nodes.filter(node => !left.includes(node) && !center.includes(node));
  const height = Math.max(minimumHeight, Math.max(left.length, center.length, right.length) * rowGap + 80);
  const place = (group, x) => group.forEach((node, index) => {
    const start = (height - ((group.length - 1) * rowGap)) / 2;
    positions[node.id] = { x, y: start + index * rowGap };
  });
  place(left, 170);
  place(center, 600);
  place(right, 1030);
  return { positions, height };
}

const compactBounds = (point, node) => ({ x: point.x - 132, y: point.y - 38, width: 264, height: node.nodeType === "group" ? 68 : 76 });

function orderGroupMembers(members, edges) {
  const ids = new Set(members.map(node => node.id));
  const indegree = new Map(members.map(node => [node.id, 0]));
  const outgoing = new Map(members.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const originalOrder = new Map(members.map((node, index) => [node.id, node.architectureGroupOrder ?? index]));
  const ready = members.filter(node => indegree.get(node.id) === 0).sort((left, right) => originalOrder.get(left.id) - originalOrder.get(right.id));
  const ordered = [];
  while (ready.length) {
    const node = ready.shift();
    ordered.push(node);
    for (const target of outgoing.get(node.id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(members.find(candidate => candidate.id === target));
        ready.sort((left, right) => originalOrder.get(left.id) - originalOrder.get(right.id));
      }
    }
  }
  const seen = new Set(ordered.map(node => node.id));
  return [...ordered, ...members.filter(node => !seen.has(node.id)).sort((left, right) => originalOrder.get(left.id) - originalOrder.get(right.id))];
}

export function layoutArchitectureExplorer(nodes, edges, { focusedNodeId = null, width = 1200, height = 720 } = {}) {
  const positions = {};
  const bounds = {};
  const lanes = [];
  let layoutWidth = width;
  let layoutHeight = height;
  const focused = nodes.find(node => node.id === focusedNodeId);
  if (!focused) {
    const required = nodes.filter(node => node.nodeType !== "group" && !node.architectureGroupId);
    const expanded = nodes.filter(node => node.nodeType !== "group" && node.architectureGroupId);
    const groups = nodes.filter(node => node.nodeType === "group");
    const recoveryManager = required.find(node => node.id === "RecoveryManager");
    const guardianVerifiers = required.filter(node => node.layer === "guardian-verifier" || node.id.endsWith("GuardianVerifier"));
    const recoveryClusterIds = new Set([recoveryManager?.id, ...guardianVerifiers.map(node => node.id)].filter(Boolean));
    const hasRecoveryCluster = Boolean(recoveryManager && guardianVerifiers.length);
    const accountStack = ["ObservedAccount", "LoomAccount", "LoomAccountProxy"]
      .map(id => required.find(node => node.id === id))
      .filter(Boolean);
    const columns = [
      required.filter(node => ["protocol", "factory"].includes(node.kind) || node.requirement === "transport-required"),
      accountStack,
      [],
      required.filter(node => !recoveryClusterIds.has(node.id) && !["EntryPoint", "ObservedAccount", "LoomAccount", "LoomAccountProxy"].includes(node.id) && !["protocol", "factory"].includes(node.kind) && node.requirement !== "transport-required")
    ];
    const placeRequired = (xValues, { fixedRowGap = false } = {}) => {
      columns.forEach((column, columnIndex) => {
        if (columnIndex !== 3 || !hasRecoveryCluster) {
          if (fixedRowGap) {
            column.forEach((node, index) => { positions[node.id] = { x: xValues[columnIndex], y: 130 + index * 106 }; });
            return;
          }
          const availableHeight = Math.max(1, height - 220);
          const gap = column.length > 1 ? Math.min(106, availableHeight / (column.length - 1)) : 0;
          column.forEach((node, index) => { positions[node.id] = { x: xValues[columnIndex], y: 110 + index * gap }; });
          return;
        }
        const upperCount = Math.ceil(column.length / 2);
        column.forEach((node, index) => {
          const y = index < upperCount ? 100 + index * 100 : height - 100 - (column.length - 1 - index) * 100;
          positions[node.id] = { x: xValues[columnIndex], y };
        });
      });
      if (!hasRecoveryCluster) return;
      const recoveryX = xValues[3];
      const verifierX = recoveryX + 320;
      const recoveryY = height / 2;
      positions[recoveryManager.id] = { x: recoveryX, y: recoveryY };
      const verifierGap = 104;
      const firstVerifierY = recoveryY - ((guardianVerifiers.length - 1) * verifierGap) / 2;
      guardianVerifiers.forEach((node, index) => { positions[node.id] = { x: verifierX, y: firstVerifierY + index * verifierGap }; });
      layoutWidth = Math.max(layoutWidth, verifierX + 180);
    };
    if (expanded.length) {
      const expandedByGroup = new Map();
      for (const node of expanded) {
        if (!expandedByGroup.has(node.architectureGroupId)) expandedByGroup.set(node.architectureGroupId, []);
        expandedByGroup.get(node.architectureGroupId).push(node);
      }
      const groupRows = [
        ...[...expandedByGroup].map(([id, members]) => ({ id, index: members[0].architectureGroupIndex ?? 0, label: members[0].architectureGroupLabel ?? id, members })),
        ...groups.map(node => ({ id: node.id, index: node.architectureGroupIndex ?? Number.MAX_SAFE_INTEGER, label: node.label ?? node.name ?? node.id, collapsedNode: node }))
      ].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
      const widestGroup = Math.max(1, ...[...expandedByGroup.values()].map(members => members.length));
      const groupRailX = hasRecoveryCluster ? 1600 : 1300;
      const memberStartX = hasRecoveryCluster ? 1810 : 1510;
      const nodeStride = 292;
      layoutWidth = Math.max(width, memberStartX + (widestGroup - 1) * nodeStride + 190);
      const coreX = [150, 450, 750, 1080];
      placeRequired(coreX);
      const rowTop = 92;
      const rowBottom = height - 82;
      const rowGap = groupRows.length > 1 ? (rowBottom - rowTop) / (groupRows.length - 1) : 0;
      groupRows.forEach((group, groupIndex) => {
        const y = rowTop + groupIndex * rowGap;
        if (group.collapsedNode) {
          positions[group.collapsedNode.id] = { x: memberStartX, y };
          return;
        }
        const ordered = orderGroupMembers(group.members, edges);
        ordered.forEach((node, index) => { positions[node.id] = { x: memberStartX + index * nodeStride, y }; });
        lanes.push({ id: group.id, label: group.label, count: group.members.length, top: y - 45, bottom: y + 45, xStart: groupRailX, xEnd: layoutWidth - 48 });
      });
    } else {
      const xValues = [140, 430, 720, 1010];
      placeRequired(xValues, { fixedRowGap: !hasRecoveryCluster });
      if (groups.length) {
        const groupWidth = 264;
        const horizontalGap = 16;
        const horizontalPadding = 48;
        const columnsCount = Math.max(1, Math.min(groups.length, Math.floor((layoutWidth - horizontalPadding * 2 + horizontalGap) / (groupWidth + horizontalGap))));
        const rowsCount = Math.ceil(groups.length / columnsCount);
        const requiredBottom = required.reduce((bottom, node) => Math.max(bottom, (positions[node.id]?.y ?? 0) + 38), 0);
        const rowGap = 88;
        const preferredFirstY = height - 72 - (rowsCount - 1) * rowGap;
        const firstY = Math.max(preferredFirstY, requiredBottom + 66);
        groups.forEach((node, index) => {
          const row = Math.floor(index / columnsCount);
          const indexInRow = index % columnsCount;
          const itemsInRow = Math.min(columnsCount, groups.length - row * columnsCount);
          const rowWidth = itemsInRow * groupWidth + Math.max(0, itemsInRow - 1) * horizontalGap;
          const firstX = (layoutWidth - rowWidth) / 2 + groupWidth / 2;
          positions[node.id] = { x: firstX + indexInRow * (groupWidth + horizontalGap), y: firstY + row * rowGap };
        });
        layoutHeight = Math.max(height, firstY + (rowsCount - 1) * rowGap + 72);
      }
    }
  } else {
    const incomingIds = new Set(edges.filter(edge => edge.to === focused.id).map(edge => edge.from));
    const outgoingIds = new Set(edges.filter(edge => edge.from === focused.id).map(edge => edge.to));
    const incoming = nodes.filter(node => incomingIds.has(node.id));
    const outgoing = nodes.filter(node => outgoingIds.has(node.id));
    const unrelated = nodes.filter(node => node.id !== focused.id && !incomingIds.has(node.id) && !outgoingIds.has(node.id));
    positions[focused.id] = { x: width / 2, y: 320 };
    incoming.forEach((node, index) => { positions[node.id] = { x: 150, y: 120 + index * 94 }; });
    outgoing.forEach((node, index) => { positions[node.id] = { x: width - 150, y: 120 + index * 94 }; });
    const unrelatedColumns = Math.max(1, Math.min(4, unrelated.length));
    const unrelatedRows = Math.ceil(unrelated.length / unrelatedColumns);
    layoutHeight = Math.max(height, 650 + Math.max(0, unrelatedRows - 1) * 94);
    unrelated.forEach((node, index) => {
      const column = index % unrelatedColumns;
      const row = Math.floor(index / unrelatedColumns);
      const columnGap = 282;
      const firstX = (width - ((unrelatedColumns - 1) * columnGap)) / 2;
      positions[node.id] = { x: firstX + column * columnGap, y: 620 + row * 94 };
    });
  }
  for (const node of nodes) {
    const point = positions[node.id] ?? { x: layoutWidth / 2, y: height / 2 };
    bounds[node.id] = node.id === focusedNodeId
      ? { x: point.x - 270, y: point.y - 210, width: 540, height: 420 }
      : compactBounds(point, node);
  }
  const neighborIds = focusedNodeId ? new Set(edges.flatMap(edge => edge.from === focusedNodeId ? [edge.to] : edge.to === focusedNodeId ? [edge.from] : [])) : new Set();
  return { positions, bounds, width: layoutWidth, height: layoutHeight, neighborIds, lanes };
}
