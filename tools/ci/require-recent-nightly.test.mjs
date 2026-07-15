import assert from "node:assert/strict";
import test from "node:test";

import { findQualifyingNightly, requireRecentNightly } from "./require-recent-nightly.mjs";

const SHA = "a".repeat(40);
const NOW = new Date("2026-07-16T00:00:00.000Z");

function run(overrides = {}) {
  return {
    id: 42,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: SHA,
    updated_at: "2026-07-12T00:00:00.000Z",
    html_url: "https://github.com/emirongrr/loom/actions/runs/42",
    ...overrides,
  };
}

test("accepts a recent successful nightly for the exact release commit", () => {
  const evidence = findQualifyingNightly([run()], {
    sha: SHA,
    branch: "main",
    now: NOW,
  });

  assert.equal(evidence.id, 42);
  assert.equal(evidence.head_sha, SHA);
  assert.equal(evidence.event, "schedule");
});

test("rejects stale, mismatched, failed, incomplete, and future nightly runs", () => {
  const invalidRuns = [
    run({ head_sha: "b".repeat(40) }),
    run({ head_branch: "release" }),
    run({ conclusion: "failure" }),
    run({ status: "in_progress" }),
    run({ event: "push" }),
    run({ updated_at: "2026-07-08T23:59:59.000Z" }),
    run({ updated_at: "2026-07-16T00:00:01.000Z" }),
  ];

  assert.throws(
    () => findQualifyingNightly(invalidRuns, { sha: SHA, branch: "main", now: NOW }),
    /no recent successful nightly verification matches release commit/u,
  );
});

test("queries the repository nightly workflow and fails closed on API errors", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { workflow_runs: [run({ event: "workflow_dispatch" })] };
      },
    };
  };
  const env = {
    GITHUB_REPOSITORY: "emirongrr/loom",
    GITHUB_SHA: SHA,
    GH_TOKEN: "test-token",
    GITHUB_API_URL: "https://api.github.test",
    RELEASE_NIGHTLY_BRANCH: "main",
  };

  const evidence = await requireRecentNightly({ fetchImpl, env, now: NOW });

  assert.equal(evidence.event, "workflow_dispatch");
  assert.equal(
    request.url,
    "https://api.github.test/repos/emirongrr/loom/actions/workflows/nightly-verification.yml/runs?branch=main&status=success&per_page=100",
  );
  assert.equal(request.options.headers.Authorization, "Bearer test-token");

  await assert.rejects(
    requireRecentNightly({
      fetchImpl: async () => ({ ok: false, status: 503 }),
      env,
      now: NOW,
    }),
    /GitHub Actions API request failed with status 503/u,
  );
});
