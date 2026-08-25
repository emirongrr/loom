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
    if (expanded.length) layoutWidth = Math.max(width, 2000);
    const columns = [
      required.filter(node => ["protocol", "factory"].includes(node.kind) || node.requirement === "transport-required"),
      required.filter(node => node.kind === "account" || node.requirement === "core").filter(node => !["protocol", "factory"].includes(node.kind)),
      required.filter(node => !["protocol", "factory", "account"].includes(node.kind) && node.requirement !== "core" && node.requirement !== "transport-required")
    ];
    if (expanded.length) {
      columns[0].forEach((node, index) => { positions[node.id] = { x: layoutWidth * .16, y: 130 + index * 106 }; });
      columns[1].forEach((node, index) => { positions[node.id] = { x: layoutWidth * .42, y: 130 + index * 106 }; });
      const rightRows = 4;
      columns[2].forEach((node, index) => {
        positions[node.id] = { x: layoutWidth * .68 + Math.floor(index / rightRows) * 340, y: 130 + (index % rightRows) * 106 };
      });
    } else {
      const xValues = [layoutWidth * .18, layoutWidth * .5, layoutWidth * .82];
      columns.forEach((column, columnIndex) => column.forEach((node, index) => {
        positions[node.id] = { x: xValues[columnIndex], y: 130 + index * 106 };
      }));
    }
    const requiredBottom = required.reduce((bottom, node) => Math.max(bottom, (positions[node.id]?.y ?? 0) + 38), 0);
    const expandedByGroup = new Map();
    for (const node of expanded) {
      if (!expandedByGroup.has(node.architectureGroupId)) expandedByGroup.set(node.architectureGroupId, []);
      expandedByGroup.get(node.architectureGroupId).push(node);
    }
    const nodeWidth = 264;
    const columnGap = 28;
    const horizontalPadding = 54;
    const columnsCount = Math.max(1, Math.floor((layoutWidth - horizontalPadding * 2 + columnGap) / (nodeWidth + columnGap)));
    const rowGap = 98;
    let cursorY = Math.max(390, requiredBottom + 112);
    for (const [groupId, members] of expandedByGroup) {
      const ordered = orderGroupMembers(members, edges);
      const rowsCount = Math.ceil(ordered.length / columnsCount);
      const laneTop = cursorY - 66;
      ordered.forEach((node, index) => {
        const row = Math.floor(index / columnsCount);
        const indexInRow = index % columnsCount;
        const itemsInRow = Math.min(columnsCount, ordered.length - row * columnsCount);
        const rowWidth = itemsInRow * nodeWidth + Math.max(0, itemsInRow - 1) * columnGap;
        const firstX = (layoutWidth - rowWidth) / 2 + nodeWidth / 2;
        positions[node.id] = { x: firstX + indexInRow * (nodeWidth + columnGap), y: cursorY + row * rowGap };
      });
      const laneBottom = cursorY + (rowsCount - 1) * rowGap + 54;
      lanes.push({ id: groupId, label: members[0].architectureGroupLabel ?? groupId, count: members.length, top: laneTop, bottom: laneBottom });
      cursorY = laneBottom + 56;
    }
    if (groups.length) {
      const groupWidth = 264;
      const horizontalGap = 16;
      const horizontalPadding = 48;
      const columnsCount = Math.max(1, Math.min(groups.length, Math.floor((layoutWidth - horizontalPadding * 2 + horizontalGap) / (groupWidth + horizontalGap))));
      const rowsCount = Math.ceil(groups.length / columnsCount);
      const rowGap = 88;
      const expandedBottom = lanes.at(-1)?.bottom ?? requiredBottom;
      const preferredFirstY = height - 72 - (rowsCount - 1) * rowGap;
      const firstY = Math.max(preferredFirstY, expandedBottom + 70);
      groups.forEach((node, index) => {
        const row = Math.floor(index / columnsCount);
        const indexInRow = index % columnsCount;
        const itemsInRow = Math.min(columnsCount, groups.length - row * columnsCount);
        const rowWidth = itemsInRow * groupWidth + Math.max(0, itemsInRow - 1) * horizontalGap;
        const firstX = (layoutWidth - rowWidth) / 2 + groupWidth / 2;
        positions[node.id] = { x: firstX + indexInRow * (groupWidth + horizontalGap), y: firstY + row * rowGap };
      });
      layoutHeight = Math.max(height, firstY + (rowsCount - 1) * rowGap + 72);
    } else if (lanes.length) {
      layoutHeight = Math.max(height, lanes.at(-1).bottom + 54);
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
