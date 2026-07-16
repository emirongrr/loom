import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_EVENTS = new Set(["schedule", "workflow_dispatch"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function findQualifyingNightly(runs, options) {
  const { sha, branch, now, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
  if (!SHA_PATTERN.test(sha ?? "")) throw new Error("release commit must be a full 40-character Git SHA");
  if (typeof branch !== "string" || branch.length === 0) throw new Error("nightly branch is required");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("current time is invalid");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("nightly maximum age must be positive");
  if (!Array.isArray(runs)) throw new Error("GitHub Actions response did not include workflow runs");

  const nowMs = now.getTime();
  const matches = runs.filter(run => {
    const updatedAt = Date.parse(run?.updated_at ?? "");
    const age = nowMs - updatedAt;
    return run?.head_sha === sha
      && run?.head_branch === branch
      && run?.status === "completed"
      && run?.conclusion === "success"
      && ALLOWED_EVENTS.has(run?.event)
      && Number.isFinite(updatedAt)
      && age >= 0
      && age <= maxAgeMs;
  });

  matches.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  if (matches.length === 0) {
    throw new Error(`no recent successful nightly verification matches release commit ${sha} on ${branch}`);
  }
  return matches[0];
}

export async function requireRecentNightly({ fetchImpl = fetch, env = process.env, now = new Date() } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const token = env.GH_TOKEN;
  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const branch = env.RELEASE_NIGHTLY_BRANCH ?? "main";

  if (!REPOSITORY_PATTERN.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
  if (typeof token !== "string" || token.length === 0) throw new Error("GH_TOKEN is required");

  const url = `${apiUrl}/repos/${repository}/actions/workflows/nightly-verification.yml/runs`
    + `?branch=${encodeURIComponent(branch)}&status=success&per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Actions API request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return findQualifyingNightly(payload?.workflow_runs, { sha, branch, now });
}

async function main() {
  const evidence = await requireRecentNightly();
  console.log(`verified recent nightly run ${evidence.id} for ${evidence.head_sha}: ${evidence.html_url}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
