import { CONFIG_FILE, readConfig } from '../core/config';
import { writeJson } from '../core/storage';
import { runPowerShell } from './powershell';

// Which Windows accounts (by SID) the agent watches — the children, never the
// parent (an admin). Model A: one PC = one dashboard device; SIDs only keep the
// parent's session out and separate several children on one PC.
//
// config.json holds an explicit list. Empty/absent means "use the default":
// every enabled local account that is NOT an administrator. The MSI (milestone 5)
// will let the parent pick; the `monitor` CLI does it in dev.

export const SID = /^S-1-5-21-[0-9-]+$/i;

export type LocalAccount = { sid: string; name: string; admin: boolean };

// Enabled local accounts and whether each is an administrator. The Administrators
// group is found by its well-known SID (S-1-5-32-544), not by name: it is called
// "Administrateurs" on a French Windows. Read through ADSI, which unlike
// Get-LocalGroupMember does not fail when the group holds an orphaned SID.
const LOCAL_ACCOUNTS = `$ErrorActionPreference = 'Stop'
$group = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\\')[1]
$admins = @(([ADSI]"WinNT://./$group,group").psbase.Invoke('Members') | ForEach-Object {
  $bytes = $_.GetType().InvokeMember('objectSid', 'GetProperty', $null, $_, $null)
  (New-Object Security.Principal.SecurityIdentifier($bytes, 0)).Value
})
$list = @(Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object {
  [pscustomobject]@{ sid = $_.SID.Value; name = $_.Name; admin = $admins -contains $_.SID.Value }
})
ConvertTo-Json -InputObject $list -Compress`;

export async function localAccounts(): Promise<LocalAccount[]> {
  const out = await runPowerShell(LOCAL_ACCOUNTS);
  return (JSON.parse(out || '[]') as LocalAccount[]).filter((a) => SID.test(a.sid));
}

// Enabled local accounts that are not administrators.
async function defaultSids(): Promise<string[]> {
  const accounts = await localAccounts().catch((): LocalAccount[] => []);
  return accounts.filter((a) => !a.admin).map((a) => a.sid);
}

// Admin only (CLI): replace the explicit list of monitored accounts.
export async function setMonitored(sids: string[]) {
  await writeJson(CONFIG_FILE, { ...(await readConfig()), monitoredSids: [...new Set(sids)] });
}

// The SIDs to watch right now: the explicit list, or the default when it is empty.
export async function monitoredSids(): Promise<string[]> {
  const config = await readConfig();
  if (config.monitoredSids?.length) return config.monitoredSids;
  return defaultSids();
}

// Turn a user name or a SID into a SID (null if the account is unknown).
export async function resolveSid(userOrSid: string): Promise<string | null> {
  if (SID.test(userOrSid.trim())) return userOrSid.trim().toUpperCase();
  const name = userOrSid.replace(/'/g, "''");
  const out = await runPowerShell(`(Get-LocalUser -Name '${name}' -ErrorAction SilentlyContinue).SID.Value`).catch(() => '');
  const sid = out.trim();
  return SID.test(sid) ? sid : null;
}

// Name shown for a SID (falls back to the SID itself).
export async function nameForSid(sid: string): Promise<string> {
  const out = await runPowerShell(
    `(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq '${sid.replace(/'/g, "''")}' }).Name`,
  ).catch(() => '');
  return out.trim() || sid;
}

export async function addMonitored(sid: string) {
  const config = await readConfig();
  const set = new Set(config.monitoredSids ?? []);
  set.add(sid);
  await writeJson(CONFIG_FILE, { ...config, monitoredSids: [...set] });
}

export async function removeMonitored(sid: string) {
  const config = await readConfig();
  await writeJson(CONFIG_FILE, { ...config, monitoredSids: (config.monitoredSids ?? []).filter((s) => s !== sid) });
}

// Back to the default (non-admins): drop the explicit list.
export async function useDefaultMonitored() {
  const config = await readConfig();
  delete config.monitoredSids;
  await writeJson(CONFIG_FILE, config);
}

// True while no explicit list is set.
export async function isDefaultMonitored(): Promise<boolean> {
  return !(await readConfig()).monitoredSids?.length;
}
