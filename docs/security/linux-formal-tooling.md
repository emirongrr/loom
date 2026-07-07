# Linux Formal Tooling

Loom's heavier prover tooling should run in a normal Linux developer
environment or a Linux CI runner. This keeps platform-specific dependency
management out of the Solidity and SDK workflow while preserving reproducible
commands for Certora and Kontrol.

This document is operational evidence guidance. It does not make Certora,
Kontrol, or any symbolic-property result a complete proof of wallet
correctness.

## Setup

From a Linux shell at the repository root:

```sh
bash tools/formal/setup-linux-provers.sh
```

The setup script installs:

- native `solc` 0.8.35;
- pinned Certora CLI from `formal/certora/requirements.txt`;
- Runtime Verification KUP and Kontrol.

## Run

From the repository root:

```sh
bash tools/formal/run-linux-provers.sh
```

This runs Certora compile-only checks and selected Kontrol proof targets. Full
Certora prover runs still require `CERTORAKEY`.

## Notes

- If KUP asks to install Nix, accept it in an interactive shell owned by the
  developer or CI user that will run Kontrol.
- On Windows, prefer running these commands from a Linux checkout path when
  possible. Filesystem translation and non-ASCII host paths can make prover
  tooling less predictable.
- Kontrol's first build can take 30-60 minutes because it fetches KEVM and K
  dependencies.
- These scripts are not part of pull-request CI. PRs run faster structure,
  compile, fuzz, and symbolic-property gates; long prover runs stay manual or
  scheduled until they are proven deterministic enough for review loops.
