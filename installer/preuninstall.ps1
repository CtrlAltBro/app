# Uninstall-time actions, run elevated by the NSIS uninstaller before the files are
# removed. Mirrors scripts\uninstall-service.ps1. $INSTDIR is removed by NSIS after.
# ASCII only: PowerShell 5.1 reads a no-BOM .ps1 as ANSI (keep text plain).
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$DataDir = "$env:ProgramData\CtrlAltBro"
)
$ErrorActionPreference = 'Continue'

$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'
# Tell the service it is being uninstalled: on its clean stop it reports an
# "uninstall" tamper event and uploads it before exiting (best effort, needs network).
if (Test-Path $DataDir) { Set-Content -Path (Join-Path $DataDir 'uninstalling.json') -Value '{}' -Encoding ASCII }
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

# Remove any IFEO launch blocks we set (Debugger -> our app), so uninstalling never
# leaves an app stuck being intercepted. Scans the registry (catches orphans too).
$ifeo = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options"
Get-ChildItem $ifeo -ErrorAction SilentlyContinue | ForEach-Object {
  $dbg = (Get-ItemProperty $_.PSPath -Name Debugger -ErrorAction SilentlyContinue).Debugger
  if ($dbg -and $dbg -match 'CtrlAltBro') {
    Remove-ItemProperty $_.PSPath -Name Debugger -Force -ErrorAction SilentlyContinue
    if ((Get-Item $_.PSPath).Property.Count -eq 0 -and (Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item $_.PSPath -Force -Recurse -ErrorAction SilentlyContinue
    }
  }
}

# State dir (token, rules, counters). The install dir itself is removed by NSIS.
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue

Write-Host "CtrlAltBro service and data removed."
