# Windows PowerShell installer — installs Gravoz into $HOME\.gemini\config\plugins\gravoz
$ErrorActionPreference = "Stop"

$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TargetDir = Join-Path $HOME ".gemini\config\plugins\gravoz"

Write-Host "[gravoz] Compilando TypeScript..."
Push-Location $RepoDir
try {
  npm install --no-audit --no-fund
  npm run build

  Write-Host "[gravoz] Instalando plugin en $TargetDir..."
  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
  }
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

  $Items = @("plugin.json", "hooks.json", "mcp_config.json", "LICENSE", "README.md", "assets", "sidecars", "skills", "dist")
  foreach ($Item in $Items) {
    Copy-Item -Recurse -Force (Join-Path $RepoDir $Item) (Join-Path $TargetDir $Item)
  }

  Write-Host "[gravoz] Listo. Abre el panel lateral de Gravoz en Antigravity para configurar tu API key de Google AI Studio."
} finally {
  Pop-Location
}
