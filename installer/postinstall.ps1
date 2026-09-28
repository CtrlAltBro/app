# Install-time actions, run elevated by the NSIS installer after the files are laid
# down. Mirrors the proven scripts\install-service.ps1 flow, but the files are
# already in place, so this only configures: state dir + ACL, optional pairing,
# service registration/start, and best-effort removal of the time-zone right.
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
Write-Host "→ Dossier de données $DataDir (SYSTEM + Administrateurs)"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
icacls $DataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# Optional pairing during install (admin). The token is DPAPI machine-scope, so the
# SYSTEM service can read it later. Blank code = pair later with the admin command.
if ($PairCode.Trim()) {
  if (-not $PcName.Trim()) { $PcName = $env:COMPUTERNAME }
  Write-Host "→ Appairage de ce PC ($PcName)"
  & $node $serviceJs pair $PairCode.Trim() $PcName.Trim()
  if ($LASTEXITCODE -ne 0) { Write-Warning "Appairage échoué (code $LASTEXITCODE) — à refaire en admin : node `"$serviceJs`" pair <code> `"<nom>`"" }
} else {
  Write-Host "→ Pas de code fourni : appaire plus tard en admin : node `"$serviceJs`" pair <code> `"<nom>`""
}

# Register and start the SYSTEM service (WinSW). Its restart policy is in the XML.
Write-Host "→ Installation du service"
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
    if (-not $line) { Write-Host "→ SeTimeZonePrivilege déjà non attribué, rien à faire."; return }
    $rhs = ($line -split '=', 2)[1].Trim()
    $kept = @($rhs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch 'S-1-5-32-545' -and $_ -notmatch '^\*?Users$' })
    $newLine = 'SeTimeZonePrivilege = ' + ($kept -join ',')
    $apply = Join-Path $tmp 'apply.inf'
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', $newLine) |
      Set-Content -Path $apply -Encoding Unicode
    secedit /configure /db (Join-Path $tmp 'sec.sdb') /cfg $apply /areas USER_RIGHTS | Out-Null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Write-Host "→ Droit « changer le fuseau horaire » retiré du groupe Users."
  } catch {
    Write-Warning "Retrait du droit fuseau horaire ignoré (non bloquant) : $_"
  }
}
Remove-TimeZoneRightFromUsers

Write-Host "OK. Le service tourne et lancera l'app dans chaque session enfant surveillée."
