#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
if [ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
  # shellcheck disable=SC1091
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

echo "==> Certora compile-only: authority"
.certora-venv-linux/bin/certoraRun \
  formal/certora/conf/loom-account-authority.conf \
  --compilation_steps_only \
  --solc "$(command -v solc)"

echo "==> Certora compile-only: initialization"
.certora-venv-linux/bin/certoraRun \
  formal/certora/conf/loom-account-initialization.conf \
  --compilation_steps_only \
  --solc "$(command -v solc)"

echo "==> Kontrol build"
kontrol build

echo "==> Kontrol selected targets"
kontrol prove --match-test LoomAccountAuthorityFormal.test_CannotRemoveLastValidator
kontrol prove --match-test LoomAccountInitializationFormal.test_InitializedAccountCannotBeReinitialized

echo "<== Linux formal prover run complete"
