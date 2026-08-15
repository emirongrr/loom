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
