#!/usr/bin/env bash
# Installer for Linux & macOS — builds and installs Gravoz natively into Antigravity IDE.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_DIR}"

echo "[gravoz] Instalando dependencias de compilación y empaquetando extensión nativa (.vsix)..."
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
npm run package

VSIX_FILE="$(ls -t "${REPO_DIR}"/gravoz-*.vsix | head -n 1)"

if command -v antigravity-ide >/dev/null 2>&1; then
  antigravity-ide --install-extension "${VSIX_FILE}" --force
elif [[ -x "/opt/antigravity/bin/antigravity-ide" ]]; then
  /opt/antigravity/bin/antigravity-ide --install-extension "${VSIX_FILE}" --force
elif command -v antigravity >/dev/null 2>&1; then
  antigravity --install-extension "${VSIX_FILE}" --force
else
  echo "[gravoz] Paquete listo en: ${VSIX_FILE}"
  echo "[gravoz] Instálalo desde Antigravity IDE: Extensiones (...) -> Install from VSIX."
  exit 0
fi

echo "[gravoz] Extensión instalada en Antigravity IDE. Recarga la ventana (Ctrl+Shift+P -> Developer: Reload Window)."
