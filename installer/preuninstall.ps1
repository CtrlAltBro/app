# Uninstall-time actions, run elevated by the NSIS uninstaller before the files are
# removed. Mirrors scripts\uninstall-service.ps1. $INSTDIR is removed by NSIS after.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$DataDir = "$env:ProgramData\CtrlAltBro"
)
$ErrorActionPreference = 'Continue'

$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'
if (Test-Path $svc) {
  & $svc stop
  & $svc uninstall
  Start-Sleep 2
}

# Per-account launch tasks and any running session app.
schtasks /query /fo csv 2>$null | Select-String 'CtrlAltBro-' | ForEach-Object {
  $name = ($_ -split '","')[0].Trim('"')
  schtasks /delete /tn $name /f 2>$null | Out-Null
}
taskkill /IM ctrlaltbro.exe /F /T 2>$null | Out-Null

# State dir (token, rules, counters). The install dir itself is removed by NSIS.
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue

Write-Host "Service et données CtrlAltBro supprimés."
