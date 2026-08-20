import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTraceRecorder, nativeTransferScenario } from "../dist/index.js";
import { createWalletLabServer } from "../server.mjs";

const executionContract = {
  id: "Example",
  name: "Example",
  address: "0x0000000000000000000000000000000000000010",
  functions: [{ name: "readValue", signature: "readValue()", selector: "0x0f2c9329", stateMutability: "view", inputs: [], outputs: [{ name: "value", type: "uint256" }] }],
  events: [],
  errors: []
};

function executionArtifact() {
  const recorder = createTraceRecorder({ runId: "execution-run", traceId: "33333333333333333333333333333333", scenario: nativeTransferScenario, now: () => 1_000 });
  const span = recorder.begin({ component: "orchestrator", phase: "deployment", explanation: "Test deployment evidence.", payload: { deployment: { nodes: [executionContract], edges: [] } } });
  recorder.finish(span, { status: "success", chainId: 31337, payload: { deployment: { nodes: [executionContract], edges: [] } } });
  return recorder.complete("success");
}

test("lab server exposes a validated no-store artifact and rejects traversal", async t => {
  const dir = mkdtempSync(join(tmpdir(), "loom-wallet-lab-"));
  const artifactPath = join(dir, "run.json");
  const artifact = createTraceRecorder({ runId: "server-run", traceId: "22222222222222222222222222222222", scenario: nativeTransferScenario, now: () => 1_000 }).complete("success");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const server = createWalletLabServer({ artifactPath, port: 0 });
  const listening = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`${listening.url}api/run`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).runId, "server-run");
  assert.equal((await fetch(`${listening.url}%2e%2e/package.json`)).status, 404);
});

test("lab server exposes only configured public Sepolia presets and connects one by identifier", async t => {
  const dir = mkdtempSync(join(tmpdir(), "loom-wallet-lab-"));
  const rpcServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: payload.method === "eth_chainId" ? "0xaa36a7" : "0x" }));
  });
  await new Promise(resolve => rpcServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => rpcServer.close(resolve)));
  const rpcAddress = rpcServer.address();
  const repoRoot = new URL("../../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("../../../examples/passkey-wallet-web/public/sepolia.deployment.json", import.meta.url), "utf8"));
  const server = createWalletLabServer({
    artifactPath: join(dir, "missing.json"),
    port: 0,
    sepoliaProfile: { repoRoot, manifest },
    sepoliaProviders: [{ id: "test-public", label: "Test public RPC", endpoint: `http://127.0.0.1:${rpcAddress.port}` }]
  });
  const listening = await server.start();
  t.after(() => server.stop());

  const providers = await fetch(`${listening.url}api/deployments/sepolia/providers`);
  assert.deepEqual(await providers.json(), { providers: [{ id: "test-public", label: "Test public RPC", origin: `http://127.0.0.1:${rpcAddress.port}` }] });

  const rejected = await fetch(`${listening.url}api/deployments/sepolia/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "attacker-controlled" }) });
  assert.equal(rejected.status, 400);

  const connected = await fetch(`${listening.url}api/deployments/sepolia/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "test-public" }) });
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).status, "mismatch");
});

test("lab execution API is same-origin, deployment-scoped, and simulation-only by default", async t => {
  const dir = mkdtempSync(join(tmpdir(), "loom-wallet-lab-"));
  const artifactPath = join(dir, "run.json");
  writeFileSync(artifactPath, JSON.stringify(executionArtifact()));
  const methods = [];
  const rpc = async (method, params) => {
    methods.push(method);
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_call") return `0x${"0".repeat(63)}7`;
    if (params[2]?.tracer === "callTracer") return { type: "STATICCALL", from: "0x0000000000000000000000000000000000000001", to: executionContract.address, input: executionContract.functions[0].selector };
    throw new Error("optional trace is unavailable");
  };
  const server = createWalletLabServer({ artifactPath, port: 0, localExecution: { rpc, chainId: 31337 } });
  const listening = await server.start();
  t.after(() => server.stop());
  const body = JSON.stringify({ network: "local", contractId: "Example", selector: "0x0f2c9329", args: [], valueWei: "0" });

  const rejectedOrigin = await fetch(`${listening.url}api/execution/simulate`, { method: "POST", headers: { "content-type": "application/json", origin: "https://attacker.example" }, body });
  assert.equal(rejectedOrigin.status, 403);
  const simulated = await fetch(`${listening.url}api/execution/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(simulated.status, 200);
  const result = await simulated.json();
  assert.equal(result.kind, "simulation");
  assert.equal(result.status, "success");
  assert.equal(result.output.decoded, "7");
  assert.equal(result.trace.contractId, "Example");
  assert.equal(methods.includes("eth_sendTransaction"), false);

  const unknown = await fetch(`${listening.url}api/execution/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ network: "local", contractId: "Unknown", selector: "0x0f2c9329", args: [], valueWei: "0" }) });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, "EXECUTION_REQUEST_REJECTED");
});
