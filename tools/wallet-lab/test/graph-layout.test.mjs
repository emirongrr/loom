import assert from "node:assert/strict";
import test from "node:test";
import { layoutArchitectureExplorer, layoutDeploymentGraph } from "../ui/graph-layout.mjs";

test("deployment graph keeps dense module columns from overlapping", () => {
  const nodes = [
    { id: "EntryPoint", kind: "protocol" },
    { id: "Factory", kind: "factory" },
    { id: "Implementation", kind: "account" },
    { id: "Observed", kind: "account" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `Module${index}`, kind: "validator" }))
  ];
  const layout = layoutDeploymentGraph(nodes);
  const moduleY = nodes.filter(node => node.kind === "validator").map(node => layout.positions[node.id].y).sort((left, right) => left - right);

  assert.ok(layout.height >= 848);
  for (let index = 1; index < moduleY.length; index += 1) {
    assert.ok(moduleY[index] - moduleY[index - 1] >= 96, "module cards must retain a full non-overlapping row gap");
  }
  assert.equal(layout.positions.EntryPoint.x, 170);
  assert.equal(layout.positions.Implementation.x, 600);
  assert.equal(layout.positions.Module0.x, 1030);
});

test("focus layout expands the selected node and places direct neighbors around it without overlap", () => {
  const nodes = [
    { id: "Factory", kind: "factory" },
    { id: "Account", kind: "account" },
    { id: "Validator", kind: "validator" },
    { id: "group:recovery", nodeType: "group" },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `Optional${index}`, kind: "validator" }))
  ];
  const edges = [
    { from: "Factory", to: "Account" },
    { from: "Account", to: "Validator" }
  ];
  const layout = layoutArchitectureExplorer(nodes, edges, { focusedNodeId: "Account", width: 1280, height: 760 });

  assert.equal(layout.bounds.Account.width, 540);
  assert.ok(layout.positions.Factory.x < layout.positions.Account.x);
  assert.ok(layout.positions.Validator.x > layout.positions.Account.x);
  for (const [leftIndex, left] of nodes.entries()) {
    for (const right of nodes.slice(leftIndex + 1)) {
      const a = layout.bounds[left.id];
      const b = layout.bounds[right.id];
      const separated = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(separated, `${left.id} and ${right.id} must not overlap`);
    }
  }
});
