#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACTOR_DIR="$ROOT_DIR/eggplant-pattern-extractor"
EXTENSION_DIR="$ROOT_DIR/eggplant-pattern-vscode"
SAMPLE_FILE="$ROOT_DIR/samples/pattern_samples.rs"
PACKAGE_JSON="$EXTENSION_DIR/package.json"
PACKAGE_LOCK="$EXTENSION_DIR/package-lock.json"
NODE_MODULES_DIR="$EXTENSION_DIR/node_modules"

ensure_extension_deps() {
  if [[ ! -d "$NODE_MODULES_DIR" ]]; then
    echo "[1/4] Installing extension dependencies..."
    npm --prefix "$EXTENSION_DIR" install
    return
  fi

  if [[ "$PACKAGE_JSON" -nt "$NODE_MODULES_DIR" || "$PACKAGE_LOCK" -nt "$NODE_MODULES_DIR" ]]; then
    echo "[1/4] package metadata changed; refreshing extension dependencies..."
    npm --prefix "$EXTENSION_DIR" install
    return
  fi

  echo "[1/4] Extension dependencies already installed; skipping npm install."
}

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

ensure_extension_deps

echo "[2/4] Building extractor..."
cargo build --manifest-path "$EXTRACTOR_DIR/Cargo.toml"

echo "[3/4] Bundling extractor into extension..."
npm --prefix "$EXTENSION_DIR" run bundle:extractor

echo "[4/4] Compiling extension..."
npm --prefix "$EXTENSION_DIR" run compile

echo "Launching VSCode Extension Development window..."
launch_vscode
