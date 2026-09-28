# Install-time actions, run elevated by the NSIS installer after the files are laid
# down. Mirrors the proven scripts\install-service.ps1 flow, but the files are
# already in place, so this only configures: state dir + ACL, optional pairing,
# service registration/start, and best-effort removal of the time-zone right.
#
# ASCII only on purpose: PowerShell 5.1 reads a no-BOM .ps1 as ANSI, so accented
# characters corrupt the parse. Keep user-facing text here plain.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$DataDir = "$env:ProgramData\CtrlAltBro",
  [string]$PairCode = "",
  [string]$PcName = ""
)
$ErrorActionPreference = 'Stop'

$node = Join-Path $InstallDir 'node.exe'
$serviceJs = Join-Path $InstallDir 'service.js'
$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'

# State dir readable/writable only by SYSTEM and Administrators: the child (a
# standard user) cannot read the device token nor edit the cached rules / counters.
Write-Host "[1/4] State dir $DataDir (SYSTEM + Administrators only)"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
icacls $DataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# Optional pairing during install (admin). The token is DPAPI machine-scope, so the
# SYSTEM service can read it later. Blank code = pair later with the admin command.
if ($PairCode.Trim()) {
  if (-not $PcName.Trim()) { $PcName = $env:COMPUTERNAME }
  Write-Host "[2/4] Pairing this PC ($PcName)"
  & $node $serviceJs pair $PairCode.Trim() $PcName.Trim()
  if ($LASTEXITCODE -ne 0) { Write-Warning "Pairing failed (code $LASTEXITCODE). Redo as admin: node service.js pair CODE NAME" }
} else {
  Write-Host "[2/4] No code given. Pair later as admin: node service.js pair CODE NAME"
}

# Register and start the SYSTEM service (WinSW). Its restart policy is in the XML.
Write-Host "[3/4] Installing the service"
& $svc install
& $svc start
Start-Sleep 2
& $svc status

# Best-effort: take "Change the time zone" (SeTimeZonePrivilege) away from standard
# users, so a child cannot shift local midnight to reset daily limits early
# (pentest F2). Never fails the install.
function Remove-TimeZoneRightFromUsers {
  try {
    $tmp = Join-Path $env:TEMP ("cab-secpol-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $export = Join-Path $tmp 'export.inf'
    secedit /export /areas USER_RIGHTS /cfg $export | Out-Null
    $line = (Get-Content $export) | Where-Object { $_ -match '^SeTimeZonePrivilege\s*=' }
    if (-not $line) { Write-Host "[4/4] SeTimeZonePrivilege already unassigned."; return }
    $rhs = ($line -split '=', 2)[1].Trim()
    $kept = @($rhs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch 'S-1-5-32-545' -and $_ -notmatch '^\*?Users$' })
    $newLine = 'SeTimeZonePrivilege = ' + ($kept -join ',')
    $apply = Join-Path $tmp 'apply.inf'
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', $newLine) |
      Set-Content -Path $apply -Encoding Unicode
    secedit /configure /db (Join-Path $tmp 'sec.sdb') /cfg $apply /areas USER_RIGHTS | Out-Null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Write-Host "[4/4] Removed 'Change the time zone' from the Users group."
  } catch {
    Write-Warning "Time-zone right removal skipped (non-fatal): $_"
  }
}
Remove-TimeZoneRightFromUsers

Write-Host "Done. The service is running and will launch the app in each monitored child session."
