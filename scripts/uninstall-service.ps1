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
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
if (-not $KeepData) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue }
if ($KeepData) { Write-Host "Service désinstallé (données conservées)." } else { Write-Host "Service désinstallé." }
