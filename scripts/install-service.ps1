# Installs the CtrlAltBro core as a SYSTEM service (milestone 3). Run as admin.
# Not the final installer (milestone 5) — a dev helper to test the service on the VM.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -WinSW C:\Tools\WinSW-x64.exe
#
# Download WinSW-x64.exe from https://github.com/winsw/winsw/releases beforehand.

param(
  [Parameter(Mandatory = $true)][string]$WinSW,
  [string]$InstallDir = "$env:ProgramFiles\CtrlAltBro",
  [string]$DataDir = "$env:ProgramData\CtrlAltBro"
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Assert-Admin {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "À lancer dans un terminal administrateur."
  }
}
Assert-Admin

$node = (Get-Command node -ErrorAction Stop).Source
$serviceJs = Join-Path $repo '.service\service.js'
$appPackaged = Join-Path $repo 'out\ctrlaltbro-win32-x64'
if (-not (Test-Path $serviceJs)) { throw "Build manquant : lance 'npm run build:service' d'abord ($serviceJs)." }
if (-not (Test-Path $appPackaged)) { throw "App manquante : lance 'npm run package' d'abord ($appPackaged)." }
if (-not (Test-Path $WinSW)) { throw "WinSW introuvable : $WinSW" }

Write-Host "→ Dossier d'installation $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $node (Join-Path $InstallDir 'node.exe') -Force
Copy-Item $serviceJs (Join-Path $InstallDir 'service.js') -Force
if (Test-Path "$serviceJs.map") { Copy-Item "$serviceJs.map" (Join-Path $InstallDir 'service.js.map') -Force }
Copy-Item $WinSW (Join-Path $InstallDir 'ctrlaltbro-svc.exe') -Force
Copy-Item (Join-Path $repo 'service\winsw\ctrlaltbro.xml') (Join-Path $InstallDir 'ctrlaltbro-svc.xml') -Force

# The packaged session app the service launches in each child's session. Under
# Program Files it inherits Users:(RX): the child can run it but not modify it.
Write-Host "→ App de session $InstallDir\app"
$appDir = Join-Path $InstallDir 'app'
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
Copy-Item $appPackaged $appDir -Recurse -Force

# State dir readable/writable only by SYSTEM and Administrators: the child (a
# standard user) cannot read the device token nor edit the cached rules / counters.
Write-Host "→ Dossier de données $DataDir (accès SYSTEM + Administrateurs)"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
icacls $DataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'
Write-Host "→ Installation du service"
& $svc install
& $svc start
Start-Sleep 2
& $svc status
Write-Host "OK. Appaire ensuite le PC :  node `"$InstallDir\service.js`" pair <code> `"<nom du PC>`""
