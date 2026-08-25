import assert from "node:assert/strict";
import test from "node:test";
import { buildArchitectureExplorer, buildFunctionExecutionLens, buildTransactionArchitectureJourney, reduceArchitectureFocus } from "../ui/architecture-explorer.mjs";

const deployment = {
  nodes: [
    { id: "EntryPoint", name: "EntryPoint", requirement: "transport-required", layer: "erc-4337-transport" },
    { id: "LoomAccount", name: "LoomAccount", requirement: "core", layer: "loom-core" },
    { id: "P256Validator", name: "P256Validator", requirement: "profile-required", layer: "authentication" },
    { id: "ECDSAValidator", name: "ECDSAValidator", requirement: "optional", layer: "authentication" },
    { id: "VaultHook", name: "VaultHook", requirement: "optional", layer: "asset-policy" },
    { id: "RecoveryManager", name: "RecoveryManager", requirement: "deployment-required", layer: "recovery" },
    { id: "P256RecoveryValidatorFactory", name: "P256RecoveryValidatorFactory", requirement: "deployment-required", layer: "recovery" },
    { id: "P256GuardianVerifier", name: "P256GuardianVerifier", requirement: "deployment-required", layer: "guardian-verifier" },
    { id: "SessionValidator", name: "SessionValidator", requirement: "optional", layer: "session" },
    { id: "DevnetTarget", name: "DevnetTarget", requirement: "test-only", layer: "scenario" }
  ],
  edges: [
    { from: "EntryPoint", to: "LoomAccount", kind: "calls", label: "validates and executes" },
    { from: "LoomAccount", to: "P256Validator", kind: "validates-with", label: "validates with" },
    { from: "LoomAccount", to: "RecoveryManager", kind: "recovers", label: "delayed recovery" },
    { from: "P256GuardianVerifier", to: "RecoveryManager", kind: "approves", label: "guardian proof" },
    { from: "P256RecoveryValidatorFactory", to: "P256Validator", kind: "creates", label: "recovered validator" }
  ]
};

test("architecture explorer starts with the required spine and deterministic collapsed groups", () => {
  const view = buildArchitectureExplorer(deployment);

  assert.deepEqual(view.visibleNodes.filter(node => node.nodeType !== "group").map(node => node.id), [
    "EntryPoint", "LoomAccount", "P256Validator", "RecoveryManager", "P256RecoveryValidatorFactory", "P256GuardianVerifier"
  ]);
  assert.deepEqual(view.visibleNodes.filter(node => node.nodeType === "group").map(node => node.id), [
    "group:authentication", "group:hooks", "group:sessions", "group:lab-only"
  ]);
  assert.equal(view.groups.some(group => group.id === "group:recovery"), false);
  assert.ok(view.visibleEdges.every(edge => edge.presentationOnly !== true), "collapsed groups must not invent architectural authority edges");
});

test("architecture explorer promotes recovery infrastructure from older optional artifacts", () => {
  const legacy = {
    nodes: deployment.nodes.map(node => node.id === "RecoveryManager" || node.id === "P256RecoveryValidatorFactory" || node.id === "P256GuardianVerifier"
      ? { ...node, requirement: "optional" }
      : node),
    edges: deployment.edges
  };

  const view = buildArchitectureExplorer(legacy);

  for (const id of ["RecoveryManager", "P256RecoveryValidatorFactory", "P256GuardianVerifier"]) {
    assert.equal(view.visibleNodes.find(node => node.id === id)?.requirement, "deployment-required");
  }
  assert.equal(view.visibleNodes.some(node => node.id === "group:recovery"), false);
});

test("expanding a group reveals only its real contracts and real edges", () => {
  const view = buildArchitectureExplorer(deployment, { expandedGroupIds: ["group:sessions"] });

  assert.ok(view.visibleNodes.some(node => node.id === "SessionValidator"));
  assert.equal(view.visibleNodes.find(node => node.id === "SessionValidator").architectureGroupId, "group:sessions");
  assert.equal(view.visibleNodes.find(node => node.id === "SessionValidator").architectureGroupLabel, "Sessions");
  assert.ok(!view.visibleNodes.some(node => node.id === "group:sessions"));
  assert.ok(view.visibleNodes.some(node => node.id === "group:authentication"));
  assert.deepEqual(view.visibleEdges.map(edge => [edge.from, edge.to]), [
    ["EntryPoint", "LoomAccount"],
    ["LoomAccount", "P256Validator"],
    ["LoomAccount", "RecoveryManager"],
    ["P256GuardianVerifier", "RecoveryManager"],
    ["P256RecoveryValidatorFactory", "P256Validator"]
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

test("transaction journey orders publisher, observed deployment contracts, and receipt without claiming publisher identity", () => {
  const tracedDeployment = {
    ...deployment,
    nodes: deployment.nodes.map((node, index) => ({ ...node, address: `0x${String(index + 1).padStart(40, "0")}` }))
  };
  const result = {
    kind: "transaction-analysis",
    status: "success",
    transactionHash: `0x${"ab".repeat(32)}`,
    gasUsed: "0x5208",
    transaction: { from: "0x0000000000000000000000000000000000000099", to: tracedDeployment.nodes[0].address },
    provenance: { classification: "loom-confirmed", basis: "trusted-deployment-code", entryPointTransport: true, accounts: [{ address: tracedDeployment.nodes[1].address, userOperationHash: `0x${"12".repeat(32)}`, success: true, runtime: "verified" }] },
    trace: {
      contractId: "EntryPoint", type: "CALL", calls: [{
        contractId: "LoomAccount", type: "CALL", calls: [{ contractId: "P256Validator", type: "CALL", calls: [] }, { type: "CALL", to: "0x0000000000000000000000000000000000000088", value: "0x2a", input: "0x", calls: [] }]
      }]
    }
  };

  const journey = buildTransactionArchitectureJourney(tracedDeployment, result);

  assert.equal(journey.verified, true);
  assert.deepEqual(journey.stages.map(stage => stage.id), ["publisher", "EntryPoint", `user-operation:0x${"12".repeat(32)}`, "LoomAccount", "P256Validator", "external:CALL:0x0000000000000000000000000000000000000088:0x:42", "account:0x0000000000000000000000000000000000000002", "receipt"]);
  assert.match(journey.stages[0].description, /does not prove the service identity/u);
  assert.match(journey.stages.at(-3).description, /forwarded 42 wei/u);
  assert.deepEqual(journey.observedNodeIds, ["EntryPoint", "LoomAccount", "P256Validator"]);
});

test("transaction journey keeps a shared EntryPoint-only transaction unverified", () => {
  const result = {
    kind: "transaction-analysis",
    status: "success",
    transaction: { from: "0x0000000000000000000000000000000000000099" },
    provenance: { classification: "erc4337-only", basis: "shared-entrypoint-only", entryPointTransport: true, accounts: [] },
    trace: null
  };

  const journey = buildTransactionArchitectureJourney(deployment, result);

  assert.equal(journey.verified, false);
  assert.deepEqual(journey.observedNodeIds, []);
  assert.equal(journey.stages.some(stage => stage.id === "EntryPoint"), true);
});
