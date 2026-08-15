import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildDeploymentEvidence, catalogFunctions, compactOpcodeTrace, normalizeCallTrace, summarizeCallTrace } from "../deployment-evidence.mjs";

test("deployment catalog derives canonical selectors and conservative behavior", () => {
  const functions = catalogFunctions("Example", [{
    type: "function",
    name: "configure",
    stateMutability: "nonpayable",
    inputs: [{ name: "items", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "amount", type: "uint256" }] }],
    outputs: []
  }]);

  assert.equal(functions[0].signature, "configure((address,uint256)[])");
  assert.match(functions[0].selector, /^0x[0-9a-f]{8}$/u);
  assert.match(functions[0].behavior, /may change contract state/i);
});

test("opcode evidence is bounded and excludes stack memory and storage payloads", () => {
  const raw = {
    gas: 90_000,
    failed: false,
    returnValue: "0x",
    structLogs: [
      { pc: 1, op: "PUSH1", gas: 90_000, gasCost: 3, depth: 1, stack: ["secret"], memory: ["secret"] },
      { pc: 3, op: "SLOAD", gas: 89_997, gasCost: 100, depth: 1, storage: { secret: "value" } },
      { pc: 4, op: "SSTORE", gas: 89_897, gasCost: 2_900, depth: 1 },
      { pc: 5, op: "RETURN", gas: 86_997, gasCost: 0, depth: 1 }
    ]
  };
  const compact = compactOpcodeTrace(raw, 2);

  assert.equal(compact.totalSteps, 4);
  assert.equal(compact.importantSteps.length, 2);
  assert.equal(compact.truncated, true);
  assert.equal(JSON.stringify(compact).includes("secret"), false);
  assert.deepEqual(compact.opcodeCounts, { PUSH1: 1, SLOAD: 1, SSTORE: 1, RETURN: 1 });
});

test("call trace normalization binds addresses and selectors to catalog functions", () => {
  const catalog = {
    nodes: [{ id: "Target", name: "Target", address: "0x000000000000000000000000000000000000beef", functions: [{ selector: "0x55241077", signature: "setValue(uint256)" }] }]
  };
  const trace = normalizeCallTrace({
    type: "CALL",
    from: "0x0000000000000000000000000000000000000001",
    to: "0x000000000000000000000000000000000000beef",
    input: `0x55241077${"00".repeat(32)}`,
    gasUsed: "0x5208",
    calls: [{ type: "STATICCALL", from: "0x1", to: "0x2", input: "0x", error: "execution reverted" }]
  }, catalog);

  assert.equal(trace.contractId, "Target");
  assert.equal(trace.functionSignature, "setValue(uint256)");
  assert.deepEqual(summarizeCallTrace(trace), { calls: 2, maxDepth: 1, errors: 1, opcodes: { CALL: 1, STATICCALL: 1 } });
});

test("deployment evidence distinguishes core, profile, optional, and test-only contracts", () => {
  const addresses = {
    EntryPoint: "0x0000000000000000000000000000000000000001",
    LoomAccount: "0x0000000000000000000000000000000000000002",
    P256Validator: "0x0000000000000000000000000000000000000003",
    VaultHook: "0x0000000000000000000000000000000000000004",
    DevnetTarget: "0x0000000000000000000000000000000000000005"
  };
  const deployment = buildDeploymentEvidence({ repoRoot: fileURLToPath(new URL("../../../", import.meta.url)), addresses, codeHashes: {} });
  const roles = Object.fromEntries(deployment.nodes.map(node => [node.id, node.requirement]));

  assert.deepEqual(deployment.nodes.map(node => node.id).sort(), Object.keys(addresses).sort());
  assert.equal(roles.LoomAccount, "core");
  assert.equal(roles.EntryPoint, "transport-required");
  assert.equal(roles.P256Validator, "profile-required");
  assert.equal(roles.VaultHook, "optional");
  assert.equal(roles.DevnetTarget, "test-only");
  const entryPoint = deployment.nodes.find(node => node.id === "EntryPoint");
  assert.deepEqual(entryPoint.source.upstream, {
    repository: "eth-infinitism/account-abstraction",
    revision: "v0.9.0",
    path: "contracts/core/EntryPoint.sol"
  });
});

test("deployment evidence keeps code and claim provenance explicit", () => {
  const deployment = buildDeploymentEvidence({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    addresses: { LoomAccount: "0x0000000000000000000000000000000000000002" },
    codeHashes: { LoomAccount: "0x1234" }
  });
  const account = deployment.nodes[0];

  assert.equal(account.source.path, "src/LoomAccount.sol");
  assert.equal(account.source.declarationLine > 0, true);
  assert.equal(account.source.language, "Solidity");
  assert.match(account.source.compilerVersion, /^0\.8\./u);
  assert.match(account.source.code, /contract LoomAccount/u);
  assert.equal(account.functions.find(fn => fn.name === "execute")?.sourceRange?.start > 0, true);
  assert.equal(account.functions.every(fn => typeof fn.purpose === "string" && fn.purpose.length > 20), true);
  assert.equal(account.events.length > 0, true);
  assert.equal(account.errors.length > 0, true);
  assert.equal(account.fields.some(field => field.name === "FREEZE_DURATION" && field.category === "constant" && field.value), true);
  assert.equal(
    account.fields.find(field => field.name === "BATCH_EXECUTION_MODE")?.resolvedValue,
    `0x01${"00".repeat(31)}`
  );
  assert.equal(account.fields.filter(field => field.category === "constant").every(field => typeof field.purpose === "string" && field.purpose.length > 20), true);
  assert.match(account.events[0].topic, /^0x[0-9a-f]{64}$/u);
  assert.match(account.errors[0].selector, /^0x[0-9a-f]{8}$/u);
  assert.deepEqual(account.evidence.map(item => item.kind), ["manifest", "runtime-code", "artifact"]);
  assert.equal(account.evidence.every(item => ["declared", "verified", "derived"].includes(item.status)), true);
});
