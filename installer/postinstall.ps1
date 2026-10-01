# Install-time actions, run elevated by the NSIS installer after the files are laid
# down. Mirrors the proven scripts\install-service.ps1 flow, but the files are
# already in place, so this only configures: state dir + ACL, server + monitored
# accounts (config.json), optional pairing, service registration/start, and
# best-effort removal of the time-zone right.
#
# ASCII only on purpose: PowerShell 5.1 reads a no-BOM .ps1 as ANSI, so accented
# characters corrupt the parse. Keep user-facing text here plain.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$DataDir = "$env:ProgramData\CtrlAltBro",
  [string]$ApiUrl = "",
  [string]$Monitored = "",
  [string]$PairCode = "",
  [string]$PcName = "",
  [int]$RePair = 0
)
$ErrorActionPreference = 'Stop'

$node = Join-Path $InstallDir 'node.exe'
$serviceJs = Join-Path $InstallDir 'service.js'
$svc = Join-Path $InstallDir 'ctrlaltbro-svc.exe'

# State dir readable/writable only by SYSTEM and Administrators: the child (a
# standard user) cannot read the device token nor edit the cached rules / counters.
Write-Host "[1/5] State dir $DataDir (SYSTEM + Administrators only)"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
icacls $DataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# Server and monitored accounts chosen in the installer, read by the service (and by
# the pairing below). Kept from a previous install when left blank. UTF-8 without BOM.
# Through the admin commands, so the rules live in one place: moving to another
# server clears the pairing (its token is worthless there). Blank = keep (upgrade).
Write-Host "[2/5] Configuration (server, monitored accounts)"
if ($ApiUrl.Trim()) {
  & $node $serviceJs server $ApiUrl.Trim()
  if ($LASTEXITCODE -ne 0) { Write-Warning "Server not saved (code $LASTEXITCODE)." }
} else {
  Write-Host "  server kept"
}
if ($Monitored.Trim()) {
  & $node $serviceJs monitor set $Monitored.Trim()
  if ($LASTEXITCODE -ne 0) { Write-Warning "Monitored accounts not saved (code $LASTEXITCODE)." }
} else {
  Write-Host "  monitored accounts kept"
}

# Optional pairing during install (admin). The token is DPAPI machine-scope, so the
# SYSTEM service can read it later. Blank code = pair later with the admin command.
if ($PairCode.Trim()) {
  if (-not $PcName.Trim()) { $PcName = $env:COMPUTERNAME }
  Write-Host "[3/5] Pairing this PC ($PcName)"
  $pairArgs = @('pair', $PairCode.Trim(), $PcName.Trim())
  if ($RePair -eq 1) { $pairArgs += '--force' }
  & $node $serviceJs @pairArgs
  if ($LASTEXITCODE -ne 0) { Write-Warning "Pairing failed (code $LASTEXITCODE). Redo as admin: node service.js pair CODE NAME" }
} else {
  Write-Host "[3/5] No code given. Pair later from the app (Parametres / appairage, admin password)"
}

# Register and start the SYSTEM service (WinSW). Its restart policy is in the XML.
# On an upgrade the service is already registered (the installer stopped it before
# replacing the files): just start it again.
if (Get-Service CtrlAltBro -ErrorAction SilentlyContinue) {
  Write-Host "[4/5] Service already installed (upgrade): starting it"
} else {
  Write-Host "[4/5] Installing the service"
  & $svc install
}
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
    if (-not $line) { Write-Host "[5/5] SeTimeZonePrivilege already unassigned."; return }
    $rhs = ($line -split '=', 2)[1].Trim()
    $kept = @($rhs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch 'S-1-5-32-545' -and $_ -notmatch '^\*?Users$' })
    $newLine = 'SeTimeZonePrivilege = ' + ($kept -join ',')
    $apply = Join-Path $tmp 'apply.inf'
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', $newLine) |
      Set-Content -Path $apply -Encoding Unicode
    secedit /configure /db (Join-Path $tmp 'sec.sdb') /cfg $apply /areas USER_RIGHTS | Out-Null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Write-Host "[5/5] Removed 'Change the time zone' from the Users group."
  } catch {
    Write-Warning "Time-zone right removal skipped (non-fatal): $_"
  }
}
Remove-TimeZoneRightFromUsers

Write-Host "Done. The service is running and will launch the app in each monitored child session."
