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

if ! command -v solc >/dev/null 2>&1; then
  echo "==> Installing solc 0.8.35"
  mkdir -p "$HOME/.local/bin"
  curl -L \
    -o "$HOME/.local/bin/solc-0.8.35" \
    "https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.35+commit.47b9dedd"
  chmod +x "$HOME/.local/bin/solc-0.8.35"
  ln -sf "$HOME/.local/bin/solc-0.8.35" "$HOME/.local/bin/solc"
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

kup install kontrol --version "$(cat formal/kontrol/version.txt)"
kup list kontrol
kontrol version || kontrol --version || true

echo "<== Loom Linux formal prover setup complete"
