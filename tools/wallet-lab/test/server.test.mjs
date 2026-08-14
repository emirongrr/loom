import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
