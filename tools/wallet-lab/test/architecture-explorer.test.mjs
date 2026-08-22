import assert from "node:assert/strict";
import test from "node:test";
import { buildArchitectureExplorer, reduceArchitectureFocus } from "../ui/architecture-explorer.mjs";

const deployment = {
  nodes: [
    { id: "EntryPoint", name: "EntryPoint", requirement: "transport-required", layer: "erc-4337-transport" },
    { id: "LoomAccount", name: "LoomAccount", requirement: "core", layer: "loom-core" },
    { id: "P256Validator", name: "P256Validator", requirement: "profile-required", layer: "authentication" },
    { id: "ECDSAValidator", name: "ECDSAValidator", requirement: "optional", layer: "authentication" },
    { id: "VaultHook", name: "VaultHook", requirement: "optional", layer: "asset-policy" },
    { id: "RecoveryManager", name: "RecoveryManager", requirement: "optional", layer: "recovery" },
    { id: "SessionValidator", name: "SessionValidator", requirement: "optional", layer: "session" },
    { id: "DevnetTarget", name: "DevnetTarget", requirement: "test-only", layer: "scenario" }
  ],
  edges: [
    { from: "EntryPoint", to: "LoomAccount", kind: "calls", label: "validates and executes" },
    { from: "LoomAccount", to: "P256Validator", kind: "validates-with", label: "validates with" },
    { from: "LoomAccount", to: "RecoveryManager", kind: "recovers", label: "optional recovery" }
  ]
};

test("architecture explorer starts with the required spine and deterministic collapsed groups", () => {
  const view = buildArchitectureExplorer(deployment);

  assert.deepEqual(view.visibleNodes.filter(node => node.nodeType !== "group").map(node => node.id), ["EntryPoint", "LoomAccount", "P256Validator"]);
  assert.deepEqual(view.visibleNodes.filter(node => node.nodeType === "group").map(node => node.id), [
    "group:authentication", "group:hooks", "group:recovery", "group:sessions", "group:lab-only"
  ]);
  assert.equal(view.groups.find(group => group.id === "group:recovery").count, 1);
  assert.ok(view.visibleEdges.every(edge => edge.presentationOnly !== true), "collapsed groups must not invent architectural authority edges");
});

test("expanding a group reveals only its real contracts and real edges", () => {
  const view = buildArchitectureExplorer(deployment, { expandedGroupIds: ["group:recovery"] });

  assert.ok(view.visibleNodes.some(node => node.id === "RecoveryManager"));
  assert.ok(!view.visibleNodes.some(node => node.id === "group:recovery"));
  assert.ok(view.visibleNodes.some(node => node.id === "group:authentication"));
  assert.deepEqual(view.visibleEdges.map(edge => [edge.from, edge.to]), [
    ["EntryPoint", "LoomAccount"],
    ["LoomAccount", "P256Validator"],
    ["LoomAccount", "RecoveryManager"]
  ]);
});

test("search reveals matching optional contracts without mutating collapsed groups", () => {
  const view = buildArchitectureExplorer(deployment, { searchQuery: "vault" });

  assert.ok(view.visibleNodes.some(node => node.id === "VaultHook"));
  assert.ok(!view.visibleNodes.some(node => node.id === "group:hooks"));
  assert.deepEqual(view.expandedGroupIds, []);
});

test("Escape unwinds ABI item and section but keeps the focused node open", () => {
  const focused = { focusedNodeId: "LoomAccount", focusedSection: "functions", focusedAbiItem: "execute" };
  const itemClosed = reduceArchitectureFocus(focused, { type: "escape" });
  const sectionClosed = reduceArchitectureFocus(itemClosed, { type: "escape" });
  const nodeClosed = reduceArchitectureFocus(sectionClosed, { type: "escape" });

  assert.deepEqual(itemClosed, { ...focused, focusedAbiItem: null });
  assert.deepEqual(sectionClosed, { ...focused, focusedSection: null, focusedAbiItem: null });
  assert.deepEqual(nodeClosed, { ...focused, focusedSection: null, focusedAbiItem: null });
});
