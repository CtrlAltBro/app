import { readJson, writeJson } from '../core/storage';
import { runPowerShell } from './powershell';

// Which Windows accounts (by SID) the agent watches — the children, never the
// parent (an admin). Model A: one PC = one dashboard device; SIDs only keep the
// parent's session out and separate several children on one PC.
//
// config.json holds an explicit list. Empty/absent means "use the default":
// every enabled local account that is NOT an administrator. The MSI (milestone 5)
// will let the parent pick; the `monitor` CLI does it in dev.

const CONFIG_FILE = 'config.json';
const SID = /^S-1-5-21-[0-9-]+$/i;

type Config = { monitoredSids?: string[] };

const readConfig = async (): Promise<Config> => (await readJson<Config>(CONFIG_FILE)) ?? {};

// Enabled local accounts that are not members of Administrators.
async function defaultSids(): Promise<string[]> {
  const script = `$ErrorActionPreference = 'Stop'
$admins = @(Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.ObjectClass -eq 'User' } | ForEach-Object { $_.SID.Value })
Get-LocalUser | Where-Object { $_.Enabled -and $admins -notcontains $_.SID.Value } | ForEach-Object { $_.SID.Value }`;
  const out = await runPowerShell(script).catch(() => '');
  return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => SID.test(s));
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
