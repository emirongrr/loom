# Decision 0012: Bind Releases To Same-Commit Nightly Evidence

Status: accepted
Date: 2026-07-16

## Problem

The tag workflow can repeat normal verification, coverage, devnet, and static
analysis, but the deep Foundry and full symbolic campaigns intentionally run in
the longer nightly workflow. Accepting the latest successful nightly on a
branch would allow a release commit that never received those checks.

This introduces a GitHub Actions metadata dependency into release publication,
so it crosses the external-service decision threshold. It does not affect
deployed accounts or wallet operation.

## Evidence

The nightly workflow already runs deep fuzz/invariants, critical-guard mutation
testing, five full Halmos properties, and the Lean model. The
production-readiness review requires a recent deep run to be joined to the same
release commit. Unit tests demonstrate that branch, SHA, event, status,
conclusion, age, future timestamps, and API failures are all checked
fail-closed.

## Options

- Repeat every nightly campaign in the tag workflow: rejected because it
  duplicates multi-hour work and makes release failure harder to diagnose.
- Accept the latest successful run on `main`: rejected because it can describe
  an earlier commit.
- Require a recent successful nightly whose `head_sha` exactly equals the tag
  commit: selected because the evidence is narrow, observable, and replay-safe.

## Decision

Release qualification queries only the repository's
`nightly-verification.yml` runs with `actions: read`. Publication requires a
completed successful `schedule` or `workflow_dispatch` run on `main`, for the
exact 40-character `GITHUB_SHA`, updated no more than seven days earlier and
not dated in the future. Missing, stale, malformed, mismatched, or unavailable
evidence blocks publication.

Acceptance requires deterministic positive and rejection tests, CI program
structure enforcement, and the existing publish job remaining dependent on all
qualification jobs.

## Residual risks

GitHub Actions and its workflow-run API become release-publication liveness
dependencies. They receive no account, deployment, signing, recovery, or asset
authority. A release commit may need a manual nightly dispatch before tagging.
This metadata check proves workflow success for the exact commit; it does not
replace physical-device, independent-bundler, signed-deployment, or live
rehearsal evidence.
