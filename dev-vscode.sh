#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACTOR_DIR="$ROOT_DIR/eggplant-pattern-extractor"
EXTENSION_DIR="$ROOT_DIR/eggplant-pattern-vscode"
SAMPLE_FILE="$ROOT_DIR/samples/pattern_samples.rs"

echo "[1/3] Building extractor..."
cargo build --manifest-path "$EXTRACTOR_DIR/Cargo.toml"

echo "[2/3] Installing extension dependencies..."
npm --prefix "$EXTENSION_DIR" install

echo "[3/3] Compiling extension..."
npm --prefix "$EXTENSION_DIR" run compile

launch_vscode() {
  if command -v code >/dev/null 2>&1; then
    exec code \
      --new-window \
      --extensionDevelopmentPath="$EXTENSION_DIR" \
      "$SAMPLE_FILE"
  fi

  if [[ "$OSTYPE" == darwin* ]]; then
    exec open -na "Visual Studio Code" --args \
      --new-window \
      --extensionDevelopmentPath="$EXTENSION_DIR" \
      "$SAMPLE_FILE"
  fi

  echo "Could not find the VSCode CLI ('code') and no macOS fallback is available." >&2
  echo "Install the 'code' shell command in VSCode, then re-run this script." >&2
  exit 1
}

echo "Launching VSCode Extension Development window..."
launch_vscode
