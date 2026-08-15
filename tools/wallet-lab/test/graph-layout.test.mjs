import assert from "node:assert/strict";
import test from "node:test";
import { layoutDeploymentGraph } from "../ui/graph-layout.mjs";

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
