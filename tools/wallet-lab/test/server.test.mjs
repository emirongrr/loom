import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTraceRecorder, nativeTransferScenario } from "../dist/index.js";
import { createWalletLabServer } from "../server.mjs";

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
