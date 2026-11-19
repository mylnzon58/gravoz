# Windows PowerShell installer — builds and installs Gravoz natively into Antigravity IDE.
$ErrorActionPreference = "Stop"

$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $RepoDir
try {
  Write-Host "[gravoz] Compilando y empaquetando extensión nativa (.vsix)..."
  npm install --no-audit --no-fund
  npm run package

  $Vsix = Get-ChildItem -Path $RepoDir -Filter "gravoz-*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (Get-Command antigravity-ide -ErrorAction SilentlyContinue) {
    antigravity-ide --install-extension $Vsix.FullName --force
  } elseif (Get-Command antigravity -ErrorAction SilentlyContinue) {
    antigravity --install-extension $Vsix.FullName --force
  } else {
    Write-Host "[gravoz] Paquete listo en: $($Vsix.FullName)"
    Write-Host "[gravoz] Instálalo en Antigravity IDE: Extensiones (...) -> Install from VSIX."
    exit 0
  }

  Write-Host "[gravoz] Extensión instalada. Recarga la ventana de Antigravity IDE para ver el icono de Gravoz en la barra lateral."
} finally {
  Pop-Location
}
