#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Loom Linux formal prover setup"
echo "root: $ROOT"
echo "user: $(whoami)"
echo "kernel: $(uname -a)"

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  git \
  openjdk-17-jdk \
  python3 \
  python3-pip \
  python3-venv \
  unzip \
  xz-utils

# One pin, three uses. `toolchain:check` compares SOLC_VERSION against
# foundry.toml, the npm dependency, and every workflow invocation, so this file
# cannot drift to a second compiler on its own.
SOLC_VERSION=0.8.35
SOLC_BINARY=solc-linux-amd64-v0.8.35+commit.47b9dedd
SOLC_SHA256=fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4

if ! command -v solc >/dev/null 2>&1; then
  echo "==> Installing solc $SOLC_VERSION"
  mkdir -p "$HOME/.local/bin"
  SOLC_PATH="$HOME/.local/bin/solc-$SOLC_VERSION"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    -o "$SOLC_PATH" \
    "https://binaries.soliditylang.org/linux-amd64/$SOLC_BINARY"
  # The Kontrol workflow verifies this same download; a prover run that skipped
  # the check would prove properties about whatever the host happened to serve.
  printf '%s  %s\n' "$SOLC_SHA256" "$SOLC_PATH" | sha256sum --check -
  chmod +x "$SOLC_PATH"
  ln -sf "$SOLC_PATH" "$HOME/.local/bin/solc"
fi
export PATH="$HOME/.local/bin:$PATH"
solc --version

echo "==> Installing Certora CLI"
python3 -m venv .certora-venv-linux
.certora-venv-linux/bin/python -m pip install --upgrade pip
.certora-venv-linux/bin/python -m pip install -r formal/certora/requirements.txt
.certora-venv-linux/bin/certoraRun --version

echo "==> Installing KUP/Kontrol"
if ! command -v kup >/dev/null 2>&1; then
  bash -c "$(curl -fsSL https://kframework.org/install)" || {
    echo
    echo "KUP installer did not complete automatically."
    echo "If it asked to install Nix, rerun this script in an interactive Linux shell and answer yes."
    exit 1
  }
fi

if [ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
  # shellcheck disable=SC1091
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

if ! command -v kup >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
fi

KONTROL_PIN="$(cat formal/kontrol/toolchain.pin)"
kup install kontrol --version "${KONTROL_PIN#*@}"
kup list kontrol
kontrol version || kontrol --version || true

echo "<== Loom Linux formal prover setup complete"
