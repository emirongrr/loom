import assert from "node:assert/strict";
import test from "node:test";

import { buildOperationLens, createEvidenceReference } from "../ui/lab-domain.mjs";

const deployment = {
  nodes: [
    { id: "EntryPoint", name: "EntryPoint", kind: "protocol", address: "0x0000000000000000000000000000000000000001" },
    { id: "ObservedAccount", name: "Observed Loom account", kind: "instance", address: "0x0000000000000000000000000000000000000002" },
    { id: "P256Validator", name: "P256Validator", kind: "validator", address: "0x0000000000000000000000000000000000000003" },
    { id: "PolicyHook", name: "PolicyHook", kind: "hook", address: "0x0000000000000000000000000000000000000004" },
    { id: "DevnetTarget", name: "DevnetTarget", kind: "target", address: "0x0000000000000000000000000000000000000005" }
  ],
  edges: []
};

const event = (phase, component, payload = {}, extra = {}) => ({
  phase,
  component,
  status: "success",
  timestamp: "2026-08-22T00:00:00.000Z",
  chainId: 31337,
  payload,
  ...extra
});

const artifact = {
  runId: "run-1",
  scenarioId: "native-transfer",
  scenario: { title: "Passkey native transfer" },
  status: "success",
  environment: { chainId: 31337 },
  events: [
    event("call-construction", "sdk", { intent: { calls: [{ target: deployment.nodes[4].address, value: "123", data: "0x55241077" }] } }, { account: deployment.nodes[1].address }),
    event("webauthn", "webauthn", { rpId: "wallet.example", origin: "https://wallet.example", credentialId: "public-test-id", challenge: "public-test-challenge" }),
    event("bundler-submission", "bundler", { method: "eth_sendUserOperation", userOperation: { sender: deployment.nodes[1].address, callData: "0x1234" } }, { userOpHash: `0x${"11".repeat(32)}` }),
    event("network", "rpc", { exchanges: [{ transport: "rpc", request: { method: "eth_getBalance" }, endpoint: "http://127.0.0.1:8545" }] }),
    event("inclusion", "tracker", { receipt: { success: true } }, { transactionHash: `0x${"22".repeat(32)}`, blockNumber: 12 })
  ],
  stateDiff: [{ name: "recipient balance", before: "0", after: "123", explanation: "The recipient received the authorized value." }]
};

const tracePayload = {
  transactionHash: `0x${"22".repeat(32)}`,
  trace: {
    type: "CALL",
    contractId: "EntryPoint",
    to: deployment.nodes[0].address,
    calls: [{
      type: "CALL",
      contractId: "ObservedAccount",
      to: deployment.nodes[1].address,
      calls: [
        { type: "CALL", contractId: "P256Validator", to: deployment.nodes[2].address, calls: [] },
        { type: "CALL", contractId: "PolicyHook", to: deployment.nodes[3].address, calls: [] },
        { type: "CALL", contractId: "DevnetTarget", to: deployment.nodes[4].address, value: "0x7b", calls: [] }
      ]
    }]
  }
};

test("evidence references reject unknown provenance and preserve bounded references", () => {
  assert.throws(() => createEvidenceReference("invented", "verified", "bad"), /unsupported evidence kind/u);
  const evidence = createEvidenceReference("observed_trace", "observed", "Observed call", { traceFrameId: "0.1", contractAddress: deployment.nodes[1].address });
  assert.deepEqual(evidence, {
    kind: "observed_trace",
    confidence: "observed",
    description: "Observed call",
    traceFrameId: "0.1",
    contractAddress: deployment.nodes[1].address
  });
});

test("operation lens keeps architecture, execution, authority, effects, and privacy evidence distinct", () => {
  const lens = buildOperationLens({ artifact, deployment, tracePayload, selectedContractId: "ObservedAccount" });
  assert.equal(lens.operation.selectedContractId, "ObservedAccount");
  assert.ok(lens.authority.actors.some(actor => actor.id === "P256Validator" && actor.abilities.includes("approve")));
  assert.ok(lens.authority.actors.some(actor => actor.id === "PolicyHook" && actor.abilities.includes("veto")));
  assert.ok(lens.authority.edges.some(edge => edge.id === "authority:P256Validator:ObservedAccount:validates" && edge.evidence[0].kind === "observed_trace"));
  assert.ok(lens.effects.some(effect => effect.evidence[0].kind === "observed_state_diff"));
  assert.ok(lens.privacy.some(disclosure => disclosure.observer === "Bundler" && disclosure.visibility === "disclosed_to_infrastructure"));
  assert.ok(lens.privacy.some(disclosure => disclosure.observer === "Public blockchain" && disclosure.visibility === "revealed_onchain"));
  assert.ok(lens.privacy.every(disclosure => disclosure.evidence.length > 0));
  assert.ok(lens.architecture.edges.every(edge => edge.graph === "architecture"));
  assert.ok(lens.execution.edges.every(edge => edge.graph === "execution"));
});

test("operation lens degrades honestly when runtime tracing is unavailable", () => {
  const lens = buildOperationLens({ artifact, deployment, tracePayload: null, selectedContractId: "ObservedAccount" });
  assert.equal(lens.capabilities.trace, "unavailable");
  assert.equal(lens.execution.edges.length, 0);
  assert.ok(lens.authority.actors.some(actor => actor.id === "P256Validator" && actor.evidence[0].kind === "observed_client"));
  assert.ok(lens.notices.some(notice => /trace unavailable/i.test(notice)));
});

test("authority and execution graph identifiers remain stable across repeated normalization", () => {
  const first = buildOperationLens({ artifact, deployment, tracePayload, selectedContractId: "DevnetTarget" });
  const second = buildOperationLens({ artifact, deployment, tracePayload, selectedContractId: "DevnetTarget" });
  assert.deepEqual(first.authority.edges.map(edge => edge.id), second.authority.edges.map(edge => edge.id));
  assert.deepEqual(first.execution.edges.map(edge => edge.id), second.execution.edges.map(edge => edge.id));
  assert.equal(new Set(first.execution.edges.map(edge => edge.id)).size, first.execution.edges.length);
});
