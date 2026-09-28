# Redeploys the currently checked-out build to the installed service on the VM.
# The service supervisor relaunches the session app every ~10 s, so we stop the
# service while the files are replaced, then start it again (it relaunches the
# fresh app in the child's session). Run as admin, from any directory.
#
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-vm.ps1            # app + service
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-vm.ps1 -App       # UI / renderer / main only
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-vm.ps1 -Service   # core / service only
#
# Build first with the matching npm script; pass -SkipBuild to deploy an existing build.

param(
  [switch]$App,
  [switch]$Service,
  [switch]$SkipBuild,
  [string]$InstallDir = "$env:ProgramFiles\CtrlAltBro",
  [string]$ServiceName = 'CtrlAltBro'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

# No target given = deploy both.
if (-not $App -and -not $Service) { $App = $true; $Service = $true }

function Assert-Admin {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "À lancer dans un terminal administrateur."
  }
}
function Invoke-Checked([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') a échoué (code $LASTEXITCODE)." }
}
Assert-Admin

$serviceJs = Join-Path $repo '.service\service.js'
$appPackaged = Join-Path $repo 'out\ctrlaltbro-win32-x64'

# Build the requested targets (unless the caller already did).
if (-not $SkipBuild) {
  if ($Service) { Write-Host "→ Build du service (npm run build:service)"; Invoke-Checked 'npm.cmd' @('run', 'build:service') }
  if ($App)     { Write-Host "→ Build de l'app (npm run package)";        Invoke-Checked 'npm.cmd' @('run', 'package') }
}
if ($Service -and -not (Test-Path $serviceJs))   { throw "Build service manquant : $serviceJs (lance sans -SkipBuild)." }
if ($App     -and -not (Test-Path $appPackaged)) { throw "App manquante : $appPackaged (lance sans -SkipBuild)." }

# Stop the service so its supervisor cannot relaunch the app mid-copy (which would
# lock the exe) and so service.js is not held open.
Write-Host "→ Arrêt du service $ServiceName"
Stop-Service $ServiceName
if ($App) {
  # Kill any session app still running in the child's session, then replace it clean.
  taskkill /IM ctrlaltbro.exe /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
  $appDir = Join-Path $InstallDir 'app'
  Write-Host "→ Déploiement de l'app → $appDir"
  if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
  Copy-Item $appPackaged $appDir -Recurse -Force
}
if ($Service) {
  Write-Host "→ Déploiement du service → $InstallDir\service.js"
  Copy-Item $serviceJs (Join-Path $InstallDir 'service.js') -Force
  if (Test-Path "$serviceJs.map") { Copy-Item "$serviceJs.map" (Join-Path $InstallDir 'service.js.map') -Force }
}

Write-Host "→ Redémarrage du service"
Start-Service $ServiceName
Start-Sleep 2
Get-Service $ServiceName | Format-Table Name, Status -AutoSize
Write-Host "OK. Le superviseur relance l'app dans la session enfant (~10 s)."
Write-Host "Logs :  Get-Content `"$InstallDir\ctrlaltbro-svc.out.log`" -Tail 20"