import { recordEvent } from '../core/events-queue';
import { readJson, removeJson, writeJson } from '../core/storage';
import { runPowerShell } from './powershell';

// Service-side tamper detectors: unclean service stop, uninstall, system clock and
// time zone changes. Each one only records an event (events-queue.ts sends it).

// Present while the service runs, removed on a clean stop: found at startup, it
// means the last run was killed, crashed, or the power was cut.
const RUNNING_FILE = 'running.json';
// Written by the uninstaller (preuninstall.ps1) just before it stops the service.
const UNINSTALLING_FILE = 'uninstalling.json';
// Last time zone seen and last event-log check, so a change made while the service
// was stopped is still caught at the next start.
const WATCH_FILE = 'time-watch.json';

const WATCH_EVERY_MS = 2 * 60 * 1000;
// Ignore small corrections (NTP resyncs); report only real jumps.
const CLOCK_JUMP_MS = 2 * 60 * 1000;

export async function checkUncleanStop() {
  const last = await readJson<{ since: string }>(RUNNING_FILE);
  if (last) {
    recordEvent(
      'service_restarted',
      "Le service CtrlAltBro s'est arrêté sans passer par un arrêt normal (process tué, plantage ou coupure de courant), puis a redémarré.",
    );
  }
  await writeJson(RUNNING_FILE, { since: new Date().toISOString() });
}

// Clean stop (service stop, PC shutdown). Reports an uninstall first if one is running.
export async function markCleanStop() {
  if (await readJson(UNINSTALLING_FILE)) {
    recordEvent('uninstall', "CtrlAltBro est en cours de désinstallation sur ce PC (action d'un administrateur).");
    await removeJson(UNINSTALLING_FILE);
  }
  await removeJson(RUNNING_FILE);
}

type WatchState = { timeZone: string; lastCheck: string };
type TimeReport = { tz: string; changes: { oldTime: string; newTime: string; process: string }[] };

// Clock resyncs by Windows itself (Windows Time, Hyper-V time sync, resume from
// sleep / hibernation) are logged by svchost.exe: not a tamper, whatever the jump.
const SYSTEM_TIME_SYNC = 'svchost.exe';

// Current Windows time zone + system time changes logged since `since`
// (System log, Kernel-General event 1: written for every change of the clock).
const script = (since: string) => `$ErrorActionPreference = 'Stop'
$since = [datetime]::Parse('${since}').ToLocalTime()
$changes = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 1; StartTime = $since } -ErrorAction SilentlyContinue | ForEach-Object {
  $d = @{}
  ([xml]$_.ToXml()).Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
  [pscustomobject]@{ oldTime = $d['OldTime']; newTime = $d['NewTime']; process = Split-Path -Leaf ([string]$d['ProcessName']) }
})
@{ tz = (Get-TimeZone).Id; changes = $changes } | ConvertTo-Json -Compress -Depth 4`;

const minutes = (ms: number) => Math.round(Math.abs(ms) / 60_000);

async function checkTime() {
  const saved = await readJson<WatchState>(WATCH_FILE);
  const now = new Date().toISOString();
  const since = saved?.lastCheck ?? new Date(Date.now() - WATCH_EVERY_MS).toISOString();
  const report = JSON.parse(await runPowerShell(script(since))) as TimeReport;

  // PowerShell 5.1 may serialize a one-item array as a bare object: normalize.
  for (const change of ([] as TimeReport['changes']).concat(report.changes ?? [])) {
    if ((change.process ?? '').toLowerCase() === SYSTEM_TIME_SYNC) continue;
    const jump = Date.parse(change.newTime) - Date.parse(change.oldTime);
    if (Number.isFinite(jump) && Math.abs(jump) >= CLOCK_JUMP_MS) {
      const way = jump > 0 ? 'avancée' : 'reculée';
      const by = change.process ? ` (via ${change.process})` : '';
      recordEvent('clock_changed', `L'heure du PC a été ${way} de ${minutes(jump)} min${by}.`);
    }
  }
  if (saved && saved.timeZone !== report.tz) {
    recordEvent('timezone_changed', `Fuseau horaire changé : ${saved.timeZone} → ${report.tz}.`);
  }
  await writeJson(WATCH_FILE, { timeZone: report.tz, lastCheck: now } satisfies WatchState);
}

export function startTimeWatch() {
  const run = () => checkTime().catch((err) => console.error('[tamper] vérification horloge/fuseau échouée:', err));
  void run();
  setInterval(run, WATCH_EVERY_MS).unref();
}
