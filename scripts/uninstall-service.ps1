# Removes the CtrlAltBro service and its files (admin). Dev helper for the VM.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1 [-KeepData]

param(
  [string]$InstallDir = "$env:ProgramFiles\CtrlAltBro",
  [string]$DataDir = "$env:ProgramData\CtrlAltBro",
  [switch]$KeepData
)
$ErrorActionPreference = 'Continue'

$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'
if (Test-Path $svc) {
  & $svc stop
  & $svc uninstall
  Start-Sleep 2
}

# Session-app launch tasks and any running session app.
schtasks /query /fo csv 2>$null | Select-String 'CtrlAltBro-' | ForEach-Object {
  $name = ($_ -split '","')[0].Trim('"')
  schtasks /delete /tn $name /f 2>$null | Out-Null
}
taskkill /IM ctrlaltbro.exe /F /T 2>$null | Out-Null

Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
if (-not $KeepData) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue }
if ($KeepData) { Write-Host "Service désinstallé (données conservées)." } else { Write-Host "Service désinstallé." }
