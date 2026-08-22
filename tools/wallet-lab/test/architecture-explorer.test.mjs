import assert from "node:assert/strict";
import test from "node:test";
import { buildArchitectureExplorer, buildFunctionExecutionLens, reduceArchitectureFocus } from "../ui/architecture-explorer.mjs";

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

test("function execution lens separates observed frames from possible architecture relationships", () => {
  const tracedDeployment = {
    ...deployment,
    nodes: deployment.nodes.map((node, index) => ({ ...node, address: `0x${String(index + 1).padStart(40, "0")}` })),
    edges: [
      ...deployment.edges,
      { from: "LoomAccount", to: "VaultHook", kind: "guarded-by", label: "may enforce policy" }
    ]
  };
  const trace = {
    type: "CALL",
    from: "0x0000000000000000000000000000000000000099",
    to: tracedDeployment.nodes[0].address,
    contractId: "EntryPoint",
    selector: "0x765e827f",
    calls: [{
      type: "CALL",
      from: tracedDeployment.nodes[0].address,
      to: tracedDeployment.nodes[1].address,
      contractId: "LoomAccount",
      selector: "0x12345678",
      functionSignature: "execute(address,uint256,bytes)",
      input: "0x12345678aabb",
      output: "0x01",
      value: "0x0",
      gasUsed: "0x5208",
      calls: [{
        type: "CALL",
        from: tracedDeployment.nodes[1].address,
        to: tracedDeployment.nodes[2].address,
        contractId: "P256Validator",
        selector: "0xabcdef01",
        functionSignature: "validate(bytes32)",
        input: "0xabcdef01ccdd",
        output: "0x01",
        value: "0x0",
        gasUsed: "0x100",
        calls: []
      }]
    }]
  };

  const lens = buildFunctionExecutionLens({ deployment: tracedDeployment, contractId: "LoomAccount", functionSelector: "0x12345678", trace });

  assert.equal(lens.status, "observed");
  assert.deepEqual(lens.observedNodeIds, ["EntryPoint", "LoomAccount", "P256Validator"]);
  assert.deepEqual(lens.possibleNodeIds, ["RecoveryManager", "VaultHook"]);
  assert.equal(lens.calls.length, 1);
  assert.deepEqual(lens.calls[0].caller, {
    contractId: "EntryPoint",
    contractName: "EntryPoint",
    from: tracedDeployment.nodes[0].address,
    callType: "CALL"
  });
  assert.deepEqual(lens.calls[0].frames.map(frame => [frame.contractId, frame.type, frame.input, frame.output]), [
    ["LoomAccount", "CALL", "0x12345678aabb", "0x01"],
    ["P256Validator", "CALL", "0xabcdef01ccdd", "0x01"]
  ]);
  assert.deepEqual(lens.observedEdges.map(edge => [edge.from, edge.to, edge.type]), [
    ["EntryPoint", "LoomAccount", "CALL"],
    ["LoomAccount", "P256Validator", "CALL"]
  ]);
});

test("function execution lens never invents calls or values when the selector was not observed", () => {
  const lens = buildFunctionExecutionLens({ deployment, contractId: "LoomAccount", functionSelector: "0xdeadbeef", trace: null });

  assert.equal(lens.status, "architecture-only");
  assert.deepEqual(lens.calls, []);
  assert.deepEqual(lens.observedNodeIds, []);
  assert.deepEqual(lens.observedEdges, []);
  assert.deepEqual(lens.possibleNodeIds, ["EntryPoint", "P256Validator", "RecoveryManager"]);
});
