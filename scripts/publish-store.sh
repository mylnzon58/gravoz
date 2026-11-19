#!/usr/bin/env bash
# Interactive publisher for Antigravity IDE's native Open VSX Extensions Store.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_DIR}"

echo "=========================================================="
echo " Publicar Gravoz en la tienda nativa Open VSX (Antigravity)"
echo "=========================================================="
echo "1. Abre en tu navegador: https://open-vsx.org/user-settings/tokens"
echo "   (Inicia sesión con tu GitHub @mylnzon58 y acepta el Publisher Agreement en Profile)"
echo "2. Pulsa 'Generate New Token' y copia el token generado."
echo ""
read -r -s -p "3. Pega aquí tu token de Open VSX y pulsa Enter: " OVSX_TOKEN
echo ""

if [[ -z "${OVSX_TOKEN}" ]]; then
  echo "[gravoz] Error: no pegaste ningún token."
  exit 1
fi

npm run package
npx ovsx create-namespace mylnzon58 -p "${OVSX_TOKEN}" || true
VSIX_FILE="$(ls -t "${REPO_DIR}"/gravoz-*.vsix | head -n 1)"
npx ovsx publish "${VSIX_FILE}" -p "${OVSX_TOKEN}"

echo "[gravoz] ¡Publicado con éxito en Open VSX! Ya puedes buscar 'Gravoz' en Extensiones de Antigravity IDE."

