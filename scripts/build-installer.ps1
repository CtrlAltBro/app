# Builds the per-machine NSIS installer (milestone 5). Run on the VM (or any Windows
# box with the app toolchain). Does NOT need admin — it only compiles the installer;
# the produced .exe is what needs admin to run.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
#   ... -SkipBuild                 # reuse an existing npm build
#   ... -WinSW C:\Tools\WinSW-x64.exe -NSIS "C:\Program Files (x86)\NSIS\makensis.exe"
#
# Prerequisite: NSIS installed (makensis.exe). Get it with:  winget install NSIS.NSIS

param(
  [string]$WinSW = "C:\Tools\WinSW-x64.exe",
  [string]$NSIS = "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version

# Server proposed by default on the installer's "Serveur" page: same source as the
# build (CTRLALTBRO_API_URL from the environment, else .env.local, else .env).
$defaultApiUrl = $env:CTRLALTBRO_API_URL
foreach ($envFile in @('.env.local', '.env')) {
  if ($defaultApiUrl) { break }
  $path = Join-Path $repo $envFile
  if (Test-Path $path) {
    $line = Get-Content $path | Where-Object { $_ -match '^\s*CTRLALTBRO_API_URL\s*=' } | Select-Object -First 1
    if ($line) { $defaultApiUrl = ($line -split '=', 2)[1].Trim().Trim('"') }
  }
}
if (-not $defaultApiUrl) { $defaultApiUrl = 'http://localhost:5173' }

if (-not (Test-Path $NSIS)) { throw "makensis introuvable : $NSIS. Installe NSIS (winget install NSIS.NSIS) ou passe -NSIS." }
if (-not (Test-Path $WinSW)) { throw "WinSW introuvable : $WinSW. Télécharge WinSW-x64.exe ou passe -WinSW." }

Push-Location $repo
try {
  if (-not $SkipBuild) {
    Write-Host "→ Build du service (npm run build:service)"; & npm.cmd run build:service; if ($LASTEXITCODE) { throw "build:service a échoué" }
    Write-Host "→ Build de l'app (npm run package)";        & npm.cmd run package;       if ($LASTEXITCODE) { throw "package a échoué" }
  }

  $appPackaged = Join-Path $repo 'out\ctrlaltbro-win32-x64'
  $serviceJs = Join-Path $repo '.service\service.js'
  if (-not (Test-Path $appPackaged)) { throw "App manquante : $appPackaged (retire -SkipBuild)." }
  if (-not (Test-Path $serviceJs))   { throw "Service manquant : $serviceJs (retire -SkipBuild)." }

  # Stage the exact layout the installer lays into $INSTDIR.
  $staging = Join-Path $repo 'installer\staging'
  Write-Host "→ Préparation des fichiers → $staging"
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  New-Item -ItemType Directory -Force $staging | Out-Null
  Copy-Item $appPackaged (Join-Path $staging 'app') -Recurse
  Copy-Item (Get-Command node).Source (Join-Path $staging 'node.exe')
  Copy-Item $serviceJs $staging
  if (Test-Path "$serviceJs.map") { Copy-Item "$serviceJs.map" $staging }
  Copy-Item $WinSW (Join-Path $staging 'ctrlaltbro-svc.exe')
  Copy-Item (Join-Path $repo 'service\winsw\ctrlaltbro.xml') (Join-Path $staging 'ctrlaltbro-svc.xml')
  Copy-Item (Join-Path $repo 'installer\postinstall.ps1') $staging
  Copy-Item (Join-Path $repo 'installer\preuninstall.ps1') $staging

  Write-Host "→ Compilation de l'installeur (v$version, serveur par défaut $defaultApiUrl)"
  & $NSIS "/DVERSION=$version" "/DSTAGING=$staging" "/DDEFAULT_API_URL=$defaultApiUrl" (Join-Path $repo 'installer\ctrlaltbro.nsi')
  if ($LASTEXITCODE) { throw "makensis a échoué (code $LASTEXITCODE)" }

  $out = Join-Path $repo "installer\ctrlaltbro-setup-$version.exe"
  Write-Host "OK. Installeur : $out"
} finally {
  Pop-Location
}
