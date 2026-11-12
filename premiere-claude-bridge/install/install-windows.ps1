# Installe le panneau Claude Bridge pour Premiere Pro (Windows, utilisateur courant, sans droits admin).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "extension"
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.local.claudebridge"

Write-Host "Copie de l'extension vers $dest"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $src "*") $dest
Copy-Item -Force (Join-Path $src ".debug") $dest

# Autorise les extensions non signées (PlayerDebugMode) pour les versions CEP récentes.
foreach ($v in 9..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
}
Write-Host "PlayerDebugMode activé (CSXS 9 à 13)."

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source (Join-Path $PSScriptRoot "configure-claude.js")
} else {
  Write-Warning "Node.js introuvable : installez Node 18+ puis lancez 'node install\configure-claude.js'."
}
Write-Host "`nTerminé. Redémarrez Premiere Pro puis ouvrez Fenêtre > Extensions > Claude Bridge, et redémarrez Claude."
