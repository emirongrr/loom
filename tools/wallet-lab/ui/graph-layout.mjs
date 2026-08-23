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

export function layoutArchitectureExplorer(nodes, edges, { focusedNodeId = null, width = 1200, height = 720 } = {}) {
  const positions = {};
  const bounds = {};
  let layoutHeight = height;
  const focused = nodes.find(node => node.id === focusedNodeId);
  if (!focused) {
    const required = nodes.filter(node => node.nodeType !== "group");
    const groups = nodes.filter(node => node.nodeType === "group");
    const columns = [
      required.filter(node => ["protocol", "factory"].includes(node.kind) || node.requirement === "transport-required"),
      required.filter(node => node.kind === "account" || node.requirement === "core").filter(node => !["protocol", "factory"].includes(node.kind)),
      required.filter(node => !["protocol", "factory", "account"].includes(node.kind) && node.requirement !== "core" && node.requirement !== "transport-required")
    ];
    const xValues = [width * .18, width * .5, width * .82];
    columns.forEach((column, columnIndex) => column.forEach((node, index) => {
      positions[node.id] = { x: xValues[columnIndex], y: 130 + index * 106 };
    }));
    if (groups.length) {
      const groupWidth = 264;
      const horizontalGap = 16;
      const horizontalPadding = 48;
      const columnsCount = Math.max(1, Math.min(groups.length, Math.floor((width - horizontalPadding * 2 + horizontalGap) / (groupWidth + horizontalGap))));
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
        const firstX = (width - rowWidth) / 2 + groupWidth / 2;
        positions[node.id] = { x: firstX + indexInRow * (groupWidth + horizontalGap), y: firstY + row * rowGap };
      });
      layoutHeight = Math.max(height, firstY + (rowsCount - 1) * rowGap + 72);
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
    const point = positions[node.id] ?? { x: width / 2, y: height / 2 };
    bounds[node.id] = node.id === focusedNodeId
      ? { x: point.x - 270, y: point.y - 210, width: 540, height: 420 }
      : compactBounds(point, node);
  }
  const neighborIds = focusedNodeId ? new Set(edges.flatMap(edge => edge.from === focusedNodeId ? [edge.to] : edge.to === focusedNodeId ? [edge.from] : [])) : new Set();
  return { positions, bounds, width, height: layoutHeight, neighborIds };
}
