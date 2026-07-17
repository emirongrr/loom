# Certora CVL Plan

Certora is the planned audit-grade rule layer for Loom's cross-function account
invariants. This directory contains the first real CVL ruleset plus the
readiness documentation that keeps claims narrow until prover runs are
reproducible.

## Initial Rule Candidates

- Validator count cannot become zero.
- Guardian and recovery authority cannot perform ordinary spending.
- Validators cannot perform guardian/recovery-only actions.
- Frozen accounts cannot execute ordinary calls.
- Recovery cannot execute before delay, after expiry, or after cancellation.
- Recovery replaces the committed validator set and cannot leave stale
  validators installed.
- Migration execution must match the scheduled call hash, destination, config,
  and execution window.
- Account factory and registry have no post-deployment account authority.
- Immutable proxy implementation address cannot change.

## Before Adding CVL Files

1. Pin Certora CLI version and invocation.
2. Add summaries for external modules and token calls.
3. Decide which rules target `LoomAccount` alone and which require scene
   contracts.
4. Run rules locally and record solver time.
5. Add CI only after commands are reproducible and license/secrets handling is
   documented.

The `.github/workflows/certora.yml` workflow always runs a readiness gate and a
Linux compile-only Certora job on pull requests that touch contracts or CVL
files. Compile-only is useful because it catches stale specs, import breakage,
and compiler drift without spending prover credits or requiring credentials.

The workflow also exposes a manual `certoraRun` prover job for configured
environments with `CERTORA_KEY`. Loom must not claim Certora coverage until that
prover job has recorded successful runtime evidence for the relevant rules.
Each target uploads commit-bound metadata, its configuration and specs, tool
versions, and the raw prover log for 30 days. A missing key fails the manual
prover job and uploads explanatory metadata; an artifact by itself is never a
successful prover result.

## GitHub Secret Setup

Do not put the Certora key in source files, issue comments, pull request
descriptions, or chat logs. Configure it as a repository Actions secret named
`CERTORA_KEY`.

Using GitHub CLI from an authenticated shell:

```sh
gh secret set CERTORA_KEY --repo emirongrr/loom
```

Or use GitHub UI:

```text
Repository Settings -> Secrets and variables -> Actions -> New repository secret
Name: CERTORA_KEY
Value: <your Certora key>
```

The workflow maps this secret to the environment variable expected by Certora:
`CERTORAKEY`.

## Current Files

- `requirements.txt` pins the Certora CLI.
- `conf/loom-account-authority.conf` defines the first prover target.
- `conf/loom-account-initialization.conf` targets initialization and
  upgrade-surface rules.
- `specs/LoomAccountAuthority.spec` defines initial account-authority rules.
- `specs/LoomAccountInitialization.spec` defines initialization and
  anti-upgrade rules.
- `specs/properties.md` describes the property taxonomy and claim boundary.

## License Boundary

`certora-cli` is pinned as an optional developer and CI prover tool. It is not
linked into Loom contracts, shipped SDK runtime packages, browser bundles, or
wallet clients. The supply-chain workflow keeps GPL-family licenses denied by
default and grants a narrow dependency-review exception only for
`pkg:pypi/certora-cli`.

## Local Commands

Install the pinned Certora CLI into a local workspace virtualenv:

```sh
npm run certora:install
npm run certora:version
```

Run the first ruleset locally when `CERTORAKEY` is configured:

```sh
CERTORAKEY=... npm run certora:run:authority
CERTORAKEY=... npm run certora:run:initialization
```

Do not commit `.certora-venv` or local prover outputs.

## Claim Boundary

CVL rules are formal specifications for selected behaviors. They are not proof
of all wallet behavior, all module compositions, external token behavior, or
future client correctness.
