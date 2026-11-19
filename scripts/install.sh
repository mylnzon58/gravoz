#!/usr/bin/env bash
# Cross-platform installer for Linux & macOS — installs Gravoz into ~/.gemini/config/plugins/gravoz
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/gravoz"

echo "[gravoz] Compilando TypeScript..."
cd "${REPO_DIR}"
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
npm run build

echo "[gravoz] Instalando plugin en ${TARGET_DIR}..."
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

cp -R \
  plugin.json \
  hooks.json \
  mcp_config.json \
  LICENSE \
  README.md \
  assets \
  sidecars \
  skills \
  dist \
  "${TARGET_DIR}/"

echo "[gravoz] Listo. Reinicia o recarga tus plugins en Antigravity y abre el panel lateral de Gravoz."
