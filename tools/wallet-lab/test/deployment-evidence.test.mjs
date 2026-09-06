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
  assert.deepEqual(functions[0].inputs[0].components.map(component => component.name), ["target", "amount"]);
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
  assert.equal(compact.steps.length, 4);
  assert.deepEqual(compact.steps.map(step => step.index), [0, 1, 2, 3]);
  assert.equal(compact.importantSteps.length, 2);
  assert.deepEqual(compact.importantSteps.map(step => step.index), [1, 2]);
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
    DevnetTarget: "0x0000000000000000000000000000000000000005",
    RecoveryManager: "0x0000000000000000000000000000000000000006",
    RecoveryIntentBoard: "0x000000000000000000000000000000000000000b",
    P256RecoveryValidatorFactory: "0x0000000000000000000000000000000000000007",
    ECDSAGuardianVerifier: "0x0000000000000000000000000000000000000008",
    P256GuardianVerifier: "0x0000000000000000000000000000000000000009",
    ERC1271GuardianVerifier: "0x000000000000000000000000000000000000000a"
  };
  const deployment = buildDeploymentEvidence({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    addresses,
    codeHashes: {},
    account: "0x000000000000000000000000000000000000000c"
  });
  const roles = Object.fromEntries(deployment.nodes.map(node => [node.id, node.requirement]));

  assert.deepEqual(
    deployment.nodes.filter(node => node.availability === "deployed").map(node => node.id).sort(),
    [...Object.keys(addresses), "ObservedAccount"].sort()
  );
  for (const name of ["LoomAccountProxy", "P256RecoveryValidator", "LoomKeystore", "KeystoreSyncRecoveryModule", "ERC7579HookShim", "ERC7579ValidatorShim"]) {
    const node = deployment.nodes.find(candidate => candidate.id === name);
    assert.equal(node.availability, "source-only");
    assert.equal(node.address, null);
    assert.equal(node.evidence.some(item => item.label === "Source catalog only"), true);
  }
  assert.equal(roles.LoomAccount, "core");
  assert.equal(roles.EntryPoint, "transport-required");
  assert.equal(roles.P256Validator, "profile-required");
  for (const name of ["RecoveryManager", "P256RecoveryValidatorFactory", "ECDSAGuardianVerifier", "P256GuardianVerifier", "ERC1271GuardianVerifier"]) {
    assert.equal(roles[name], "deployment-required");
  }
  assert.equal(roles.VaultHook, "optional");
  assert.equal(roles.RecoveryIntentBoard, "optional");
  assert.equal(roles.DevnetTarget, "test-only");
  const intentBoard = deployment.nodes.find(node => node.id === "RecoveryIntentBoard");
  assert.deepEqual(intentBoard.functions.map(item => item.signature).sort(), [
    "MAX_SIGNATURE_BYTES()",
    "announce(address,address,bytes32,address,bytes32,bytes32,uint8,uint48)",
    "publishApproval(address,address,bytes32,address,bytes32,bytes32,uint8,(address,bytes32,bytes32,bytes,bytes32[])[])",
    "publishCancellation(address,address,(address,bytes32,bytes32,bytes,bytes32[])[])"
  ].sort());
  assert.deepEqual(intentBoard.events.map(item => item.name).sort(), [
    "RecoveryAnnounced", "RecoveryApprovalPublished", "RecoveryCancellationPublished"
  ]);
  assert.deepEqual(intentBoard.errors.map(item => item.name).sort(), [
    "InvalidApproval", "NoPendingRecovery", "SignatureTooLarge", "SingleApprovalRequired", "UnknownRecoveryManager"
  ]);
  assert.deepEqual(intentBoard.fields.map(field => [field.name, field.category, field.resolvedValue]), [
    ["MAX_SIGNATURE_BYTES", "constant", "4096"]
  ]);
  assert.equal(intentBoard.fields.some(field => field.category === "storage"), false);
  assert.ok(deployment.edges.some(edge => edge.from === "RecoveryIntentBoard" && edge.to === "RecoveryManager" && edge.kind === "reads-recovery-state"));
  assert.ok(deployment.edges.some(edge => edge.from === "RecoveryIntentBoard" && edge.to === "ObservedAccount" && edge.kind === "reads-account-state"));
  assert.ok(!deployment.edges.some(edge => edge.from === "RecoveryIntentBoard" && edge.kind === "recovers"));
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
  const account = deployment.nodes.find(node => node.id === "LoomAccount");

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

test("deployment evidence distinguishes shared account code from a deployed wallet proxy", () => {
  const deployment = buildDeploymentEvidence({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    addresses: {
      EntryPoint: "0x0000000000000000000000000000000000000001",
      LoomAccount: "0x0000000000000000000000000000000000000002",
      LoomAccountFactory: "0x0000000000000000000000000000000000000003",
      P256Validator: "0x0000000000000000000000000000000000000005",
      RecoveryManager: "0x0000000000000000000000000000000000000006"
    },
    codeHashes: {},
    account: "0x0000000000000000000000000000000000000004"
  });
  const byId = id => deployment.nodes.find(node => node.id === id);

  assert.equal(byId("LoomAccount").name, "LoomAccount · shared code");
  assert.equal(byId("LoomAccountProxy").name, "LoomAccountProxy · template");
  assert.equal(byId("ObservedAccount").name, "Loom wallet · proxy instance");
  assert.match(byId("ObservedAccount").responsibility, /balances, nonce, validators, and guardian configuration/u);
  assert.ok(deployment.edges.some(edge => edge.from === "LoomAccountFactory" && edge.to === "LoomAccount" && edge.kind === "references"));
  assert.ok(deployment.edges.some(edge => edge.from === "LoomAccountFactory" && edge.to === "ObservedAccount" && edge.kind === "creates"));
  assert.ok(deployment.edges.some(edge => edge.from === "LoomAccountFactory" && edge.to === "ObservedAccount" && /one proxy contract per wallet/u.test(edge.label)));
  assert.ok(deployment.edges.some(edge => edge.from === "ObservedAccount" && edge.to === "LoomAccount" && edge.kind === "delegates" && /shared code \/ wallet state/u.test(edge.label)));
  assert.ok(deployment.edges.some(edge => edge.from === "EntryPoint" && edge.to === "ObservedAccount"));
  assert.ok(deployment.edges.some(edge => edge.from === "ObservedAccount" && edge.to === "P256Validator"));
  assert.ok(deployment.edges.some(edge => edge.from === "RecoveryManager" && edge.to === "ObservedAccount"));
  assert.ok(!deployment.edges.some(edge => edge.from === "LoomAccountFactory" && edge.to === "LoomAccount" && edge.kind === "creates"));
  assert.ok(!deployment.edges.some(edge => edge.from === "EntryPoint" && edge.to === "LoomAccount"));
  assert.ok(!deployment.edges.some(edge => edge.from === "LoomAccount" && edge.to === "P256Validator"));
  assert.ok(!deployment.edges.some(edge => edge.from === "RecoveryManager" && edge.to === "LoomAccount"));
});
