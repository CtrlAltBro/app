# Prepares the installer's "Serveur", "Comptes surveilles" and "Appairage" pages.
# Writes, in UTF-16LE without BOM (read by NSIS with FileReadUTF16LE):
#   URL|<apiUrl>                         when an existing config.json has a server
#   SID|isAdmin(0/1)|checked(0/1)|name   one per enabled local account
# "checked" keeps the accounts of an existing install (upgrade); on a fresh install
# every non-administrator is checked. The Administrators group is found by its
# well-known SID, not by name ("Administrateurs" on a French Windows), through ADSI,
# which unlike Get-LocalGroupMember does not fail on an orphaned member.
# ASCII only: PowerShell 5.1 reads a no-BOM .ps1 as ANSI.
#   PAIRED|<deviceName>                  when this PC is already paired (upgrade)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Config = "$env:ProgramData\CtrlAltBro\config.json",
  [string]$Device = "$env:ProgramData\CtrlAltBro\device.json"
)
$ErrorActionPreference = 'Stop'

$pairedName = $null
if (Test-Path $Device) {
  try { $pairedName = (Get-Content $Device -Raw | ConvertFrom-Json).deviceName } catch { $pairedName = $null }
  if (-not $pairedName) { $pairedName = '?' }
}

$existing = $null
if (Test-Path $Config) {
  try { $existing = Get-Content $Config -Raw | ConvertFrom-Json } catch { $existing = $null }
}
$kept = @()
if ($existing -and $existing.monitoredSids) { $kept = @($existing.monitoredSids) }

$group = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\')[1]
$admins = @(([ADSI]"WinNT://./$group,group").psbase.Invoke('Members') | ForEach-Object {
  $bytes = $_.GetType().InvokeMember('objectSid', 'GetProperty', $null, $_, $null)
  (New-Object Security.Principal.SecurityIdentifier($bytes, 0)).Value
})

$lines = @()
if ($existing -and $existing.apiUrl) { $lines += "URL|$($existing.apiUrl)" }
if ($pairedName) { $lines += "PAIRED|$pairedName" }
$lines += @(Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object {
  $sid = $_.SID.Value
  $admin = $admins -contains $sid
  $checked = if ($kept.Count) { $kept -contains $sid } else { -not $admin }
  '{0}|{1}|{2}|{3}' -f $sid, [int]$admin, [int]$checked, $_.Name
})
[IO.File]::WriteAllLines($Out, [string[]]$lines, (New-Object Text.UnicodeEncoding($false, $false)))
