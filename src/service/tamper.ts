import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordEvent } from '../core/events-queue';
import { readJson, removeJson, writeJson } from '../core/storage';
import { runPowerShell } from './powershell';

const run = promisify(execFile);
const reg = (args: string[]) => run('reg.exe', args, { windowsHide: true });

// Service-side tamper detectors: unclean service stop, uninstall, Safe Mode boot,
// system clock and time zone changes. Each one only records an event (events-queue.ts
// sends it).

const SAFEBOOT = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot';
const SERVICE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CtrlAltBro';

// Present while the service runs, removed on a clean stop: found at startup, it
// means the last run was killed, crashed, or the power was cut.
const RUNNING_FILE = 'running.json';
// Written by the uninstaller (preuninstall.ps1) just before it stops the service.
const UNINSTALLING_FILE = 'uninstalling.json';
// Last time zone seen and last event-log record read, so a change made while the
// service was stopped is still caught at the next start.
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

// Make the service also start in Safe Mode (minimal and with-network), so a child who
// reboots into Safe Mode to escape the limits keeps being enforced, and clear the
// Tcpip dependency that would otherwise stop it from starting in minimal Safe Mode
// (the core already tolerates the network being down). Idempotent; SYSTEM only.
export async function ensureSafeBootStart() {
  for (const set of ['Minimal', 'Network']) {
    await reg(['add', `${SAFEBOOT}\\${set}\\CtrlAltBro`, '/ve', '/t', 'REG_SZ', '/d', 'Service', '/f']).catch(() => undefined);
  }
  await reg(['delete', SERVICE_KEY, '/v', 'DependOnService', '/f']).catch(() => undefined);
}

// The SafeBoot\Option key exists only when the PC is currently in Safe Mode.
export async function checkSafeMode() {
  const inSafeMode = await reg(['query', `${SAFEBOOT}\\Option`]).then(() => true, () => false);
  if (inSafeMode) {
    recordEvent(
      'safe_mode',
      'Le PC a démarré en mode sans échec, une façon connue de désactiver les protections. CtrlAltBro tourne quand même.',
    );
  }
}

// Clean stop (service stop, PC shutdown). Reports an uninstall first if one is running.
export async function markCleanStop() {
  if (await readJson(UNINSTALLING_FILE)) {
    recordEvent('uninstall', "CtrlAltBro est en cours de désinstallation sur ce PC (action d'un administrateur).");
    await removeJson(UNINSTALLING_FILE);
  }
  await removeJson(RUNNING_FILE);
}

type WatchState = { timeZone: string; lastRecord?: number };
type TimeReport = {
  tz: string;
  latest: number;
  changes: { record: number; oldTime: string; newTime: string; process: string }[];
};

// Clock resyncs by Windows itself (Windows Time, Hyper-V time sync, resume from
// sleep / hibernation) are logged by svchost.exe: not a tamper, whatever the jump.
const SYSTEM_TIME_SYNC = 'svchost.exe';

// Current Windows time zone + system time changes (System log, Kernel-General
// event 1, written for every change of the clock) logged after record `after`.
// Records are followed by their EventRecordID, which always grows: filtering by
// date would miss a clock set *back* (its event is dated before the last check).
// `after` < 0: first run, only return the latest record id (don't report history).
const script = (after: number) => `$ErrorActionPreference = 'Stop'
$after = ${after}
$changes = @()
if ($after -ge 0) {
  $xpath = "*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=1) and (EventRecordID > $after)]]"
  $changes = @(Get-WinEvent -LogName System -FilterXPath $xpath -ErrorAction SilentlyContinue | ForEach-Object {
    $d = @{}
    ([xml]$_.ToXml()).Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
    [pscustomobject]@{ record = $_.RecordId; oldTime = $d['OldTime']; newTime = $d['NewTime']; process = Split-Path -Leaf ([string]$d['ProcessName']) }
  })
} else {
  $after = (Get-WinEvent -LogName System -MaxEvents 1).RecordId
}
@{ tz = (Get-TimeZone).Id; latest = $after; changes = $changes } | ConvertTo-Json -Compress -Depth 4`;

const minutes = (ms: number) => Math.round(Math.abs(ms) / 60_000);

async function checkTime() {
  const saved = await readJson<WatchState>(WATCH_FILE);
  const after = saved?.lastRecord ?? -1;
  const report = JSON.parse(await runPowerShell(script(after))) as TimeReport;
  // PowerShell 5.1 may serialize a one-item array as a bare object: normalize.
  const changes = ([] as TimeReport['changes']).concat(report.changes ?? []);
  const lastRecord = Math.max(report.latest, ...changes.map((c) => c.record));

  for (const change of changes) {
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
  await writeJson(WATCH_FILE, { timeZone: report.tz, lastRecord } satisfies WatchState);
}

export function startTimeWatch() {
  const run = () => checkTime().catch((err) => console.error('[tamper] vérification horloge/fuseau échouée:', err));
  void run();
  setInterval(run, WATCH_EVERY_MS).unref();
}
