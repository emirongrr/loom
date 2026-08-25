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

test("expanded optional contracts never overlap the remaining collapsed groups", () => {
  const nodes = [
    { id: "EntryPoint", kind: "protocol", requirement: "transport-required" },
    { id: "Factory", kind: "factory", requirement: "core" },
    { id: "Account", kind: "account", requirement: "core" },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `Optional${index}`, kind: "validator", requirement: "optional" })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: `group:${index}`, nodeType: "group" }))
  ];
  const layout = layoutArchitectureExplorer(nodes, [], { width: 1200, height: 720 });

  for (const [leftIndex, left] of nodes.entries()) {
    for (const right of nodes.slice(leftIndex + 1)) {
      const a = layout.bounds[left.id];
      const b = layout.bounds[right.id];
      const separated = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(separated, `${left.id} and ${right.id} must not overlap`);
    }
  }
  assert.ok(layout.height > 720, "the canvas must grow when expanded modules need more rows");
});

test("expanded groups form stacked horizontal relationship lanes instead of one vertical module column", () => {
  const nodes = [
    { id: "EntryPoint", kind: "protocol", requirement: "transport-required" },
    { id: "Account", kind: "account", requirement: "core" },
    { id: "RecoveryManager", kind: "recovery", requirement: "deployment-required" },
    ...["AuthA", "AuthB", "AuthC"].map(id => ({ id, kind: "validator", requirement: "optional", architectureGroupId: "group:authentication", architectureGroupLabel: "Authentication", architectureGroupIndex: 0 })),
    ...["HookA", "HookB"].map(id => ({ id, kind: "hook", requirement: "optional", architectureGroupId: "group:hooks", architectureGroupLabel: "Hooks", architectureGroupIndex: 1 })),
    { id: "group:sessions", nodeType: "group", count: 2, architectureGroupIndex: 2 },
    { id: "group:lab-only", nodeType: "group", count: 1, architectureGroupIndex: 3 }
  ];
  const edges = [
    { from: "Account", to: "AuthA" },
    { from: "AuthA", to: "AuthB" },
    { from: "AuthB", to: "AuthC" },
    { from: "Account", to: "HookA" },
    { from: "HookA", to: "HookB" }
  ];
  const layout = layoutArchitectureExplorer(nodes, edges, { width: 1200, height: 760 });
  const auth = ["AuthA", "AuthB", "AuthC"].map(id => layout.positions[id]);
  const hooks = ["HookA", "HookB"].map(id => layout.positions[id]);

  assert.equal(new Set(auth.map(point => point.y)).size, 1, "one expanded group should read left to right");
  assert.deepEqual(auth.map(point => point.x), [...auth.map(point => point.x)].sort((left, right) => left - right));
  assert.equal(new Set(hooks.map(point => point.y)).size, 1);
  assert.ok(hooks[0].y > auth[0].y, "expanded groups should occupy separate stacked lanes");
  assert.deepEqual(layout.lanes.map(lane => lane.id), ["group:authentication", "group:hooks"]);
  assert.ok(layout.width > 1200, "expanded groups should consume horizontal canvas instead of shrinking into a tall fixed-width viewBox");
  assert.equal(layout.height, 760, "opening groups must not grow the canvas downward");
  assert.ok(layout.positions.AuthC.x > layout.positions.AuthA.x, "group members should consume horizontal space");
  assert.ok(layout.positions["group:sessions"].y > hooks[0].y, "collapsed and expanded groups should share the same fixed lane stack");
});

test("opening every optional group grows only the horizontal canvas", () => {
  const nodes = [
    { id: "Account", kind: "account", requirement: "core" },
    ...Array.from({ length: 7 }, (_, groupIndex) => ({
      id: `Module${groupIndex}`,
      kind: "validator",
      requirement: "optional",
      architectureGroupId: `group:${groupIndex}`,
      architectureGroupLabel: `Group ${groupIndex + 1}`,
      architectureGroupIndex: groupIndex
    }))
  ];
  const edges = nodes.slice(1).map(node => ({ from: "Account", to: node.id }));
  const layout = layoutArchitectureExplorer(nodes, edges, { width: 1200, height: 760 });

  assert.equal(layout.height, 760);
  assert.ok(Math.max(...nodes.slice(1).map(node => layout.positions[node.id].y)) < 720);
  assert.ok(layout.width > 1200);
});

test("account topology stacks the wallet proxy above its shared code between deployers and modules", () => {
  const nodes = [
    { id: "LoomAccountFactory", kind: "factory", requirement: "core" },
    { id: "EntryPoint", kind: "protocol", requirement: "transport-required" },
    { id: "ObservedAccount", kind: "account", requirement: "core", layer: "account-instance" },
    { id: "LoomAccount", kind: "account", requirement: "core", layer: "loom-core" },
    { id: "P256Validator", kind: "validator", requirement: "profile-required" }
  ];
  const edges = [
    { from: "LoomAccountFactory", to: "ObservedAccount" },
    { from: "EntryPoint", to: "ObservedAccount" },
    { from: "ObservedAccount", to: "LoomAccount" },
    { from: "ObservedAccount", to: "P256Validator" }
  ];
  const layout = layoutArchitectureExplorer(nodes, edges, { width: 1200, height: 760 });

  assert.ok(layout.positions.LoomAccountFactory.x < layout.positions.ObservedAccount.x);
  assert.ok(layout.positions.EntryPoint.x < layout.positions.ObservedAccount.x);
  assert.equal(layout.positions.ObservedAccount.x, layout.positions.LoomAccount.x);
  assert.ok(layout.positions.ObservedAccount.y < layout.positions.LoomAccount.y);
  assert.ok(layout.positions.ObservedAccount.x < layout.positions.P256Validator.x);
});

test("recovery manager expands horizontally into a vertical guardian verifier stack", () => {
  const nodes = [
    { id: "ObservedAccount", kind: "account", requirement: "core", layer: "account-instance" },
    { id: "RecoveryManager", kind: "recovery", requirement: "deployment-required", layer: "recovery" },
    ...["ECDSAGuardianVerifier", "P256GuardianVerifier", "ERC1271GuardianVerifier"].map(id => ({
      id,
      kind: "contract",
      requirement: "deployment-required",
      layer: "guardian-verifier"
    }))
  ];
  const edges = [
    { from: "RecoveryManager", to: "ObservedAccount" },
    ...nodes.slice(2).map(node => ({ from: node.id, to: "RecoveryManager" }))
  ];
  const layout = layoutArchitectureExplorer(nodes, edges, { width: 1200, height: 760 });
  const verifiers = nodes.slice(2).map(node => layout.positions[node.id]);

  assert.ok(layout.positions.ObservedAccount.x < layout.positions.RecoveryManager.x);
  assert.ok(verifiers.every(point => point.x > layout.positions.RecoveryManager.x));
  assert.equal(new Set(verifiers.map(point => point.x)).size, 1, "guardian verifiers should form one vertical column");
  assert.equal(new Set(verifiers.map(point => point.y)).size, verifiers.length, "guardian verifiers should stack without overlap");
  assert.ok(layout.positions.RecoveryManager.y > Math.min(...verifiers.map(point => point.y)));
  assert.ok(layout.positions.RecoveryManager.y < Math.max(...verifiers.map(point => point.y)));
  assert.ok(layout.width > 1200, "the recovery cluster should consume horizontal canvas instead of growing downward");
});
