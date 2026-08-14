import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertWalletLabArtifact,
  createTraceRecorder,
  defineWalletLabScenario,
  nativeTransferScenario
} from "../dist/index.js";

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("trace recorder correlates ordered lifecycle events and durations", () => {
  const recorder = createTraceRecorder({
    runId: "run-1",
    traceId: "0123456789abcdef0123456789abcdef",
    scenario: nativeTransferScenario,
    now: clock(1_000, 1_010, 1_025, 1_030)
  });
  const span = recorder.begin({ component: "sdk", phase: "userop-preparation", explanation: "prepare", payload: { nonce: 0n } });
  recorder.finish(span, { status: "success", payload: { nonce: 1n } });
  const artifact = recorder.complete("success");

  assertWalletLabArtifact(artifact);
  assert.equal(artifact.events.length, 1);
  assert.equal(artifact.events[0].durationMs, 15);
  assert.equal(artifact.events[0].payload.nonce, "1");
  assert.equal(artifact.events[0].monotonicSequence, 1);
});

test("trace recorder redacts secret fields and endpoint credentials", () => {
  const recorder = createTraceRecorder({
    runId: "run-redaction",
    traceId: "abcdefabcdefabcdefabcdefabcdefab",
    scenario: nativeTransferScenario,
    now: () => 1_000
  });
  const span = recorder.begin({
    component: "rpc",
    phase: "environment",
    explanation: "redaction",
    payload: {
      privateKey: "never-write-me",
      rpcUrl: "https://user:token@example.test/path?key=secret"
    }
  });
  recorder.finish(span, { status: "success" });
  const artifact = recorder.complete("success");
  const text = JSON.stringify(artifact);

  assert.equal(text.includes("never-write-me"), false);
  assert.equal(text.includes("token"), false);
  assert.equal(text.includes("?key="), false);
  assert.match(text, /https:\/\/example\.test/);
  assert.deepEqual(artifact.redaction.removedFields, ["privateKey"]);
});

test("scenario validation rejects duplicate actions before execution", () => {
  assert.throws(
    () => defineWalletLabScenario({ ...nativeTransferScenario, actions: [nativeTransferScenario.actions[0], nativeTransferScenario.actions[0]] }),
    /duplicate wallet lab action id/
  );
});

test("artifact validation rejects cross-run events and non-monotonic sequences", () => {
  const recorder = createTraceRecorder({
    runId: "run-invalid",
    traceId: "11111111111111111111111111111111",
    scenario: nativeTransferScenario,
    now: () => 1_000
  });
  const span = recorder.begin({ component: "sdk", phase: "intent", explanation: "intent" });
  recorder.finish(span, { status: "success" });
  const artifact = structuredClone(recorder.complete("success"));
  artifact.events[0].runId = "another-run";
  assert.throws(() => assertWalletLabArtifact(artifact), /correlation identifiers/);
});

test("failure closes the active boundary and records a safe diagnostic", () => {
  const recorder = createTraceRecorder({
    runId: "run-failure",
    traceId: "44444444444444444444444444444444",
    scenario: nativeTransferScenario
  });
  recorder.begin({ component: "bundler", phase: "gas-estimation", status: "waiting-bundler", explanation: "Estimating" });
  recorder.fail(new Error("simulation rejected at https://user:token@example.test/private?apiKey=secret"));
  const artifact = recorder.complete("error");
  assert.equal(artifact.firstFailingBoundary, "bundler");
  assert.equal(artifact.events[0].status, "error");
  assert.equal(artifact.events[0].errorCode, "Error");
  assert.match(JSON.stringify(artifact.events[0].payload), /simulation rejected/u);
  assert.equal(JSON.stringify(artifact).includes("user:token"), false);
  assert.equal(JSON.stringify(artifact).includes("apiKey=secret"), false);
});

test("reviewed failure fixture remains self-contained and schema-valid", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/failing-gas-estimation.v1.json", import.meta.url), "utf8"));
  assertWalletLabArtifact(fixture);
  assert.equal(fixture.firstFailingBoundary, "bundler");
  assert.equal(fixture.scenario.id, fixture.scenarioId);
  assert.equal(JSON.stringify(fixture).includes("privateKey"), false);
});
